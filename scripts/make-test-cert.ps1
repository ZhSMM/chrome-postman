<#
    make-test-cert.ps1 -- generate a self-signed certificate for the native-bridge E2E test.

    WHY THIS FILE IS ASCII ONLY
    ----------------------------
    Windows PowerShell 5.1 reads .ps1 files WITHOUT a BOM as ANSI (system code page).
    On a Chinese Windows that means GBK decoding, and any Chinese comment can turn
    into a parse error. Keeping this file pure ASCII sidesteps the problem entirely
    (and works identically under PowerShell 5.1 and PowerShell 7).

    WHY NOT New-SelfSignedCertificate
    ---------------------------------
    That cmdlet creates the key inside the Windows certificate store. Exporting the
    private key back out is awkward (the CNG key does not implement the legacy
    Export() method), and it leaves state in the user's cert store.

    Instead we use the plain .NET X509 API (CertificateRequest), which creates the
    key in memory and hands us both PEM files directly. Nothing touches the cert
    store, so there is nothing to clean up.

    WHAT IT DOES
    ------------
      1. Creates a 2048-bit RSA key in memory.
      2. Builds a self-signed certificate for "localhost" with:
           - basic constraints (CA=true, so the self-signed chain is self-consistent)
           - key usage (digitalSignature + keyEncipherment)
           - subject alternative name: DNS:localhost
         and a 2 day lifetime (deliberately short -- it is a test artifact).
      3. Writes key.pem (PKCS#8) and cert.pem (X.509 DER).

    Both files are accepted by Node's https.createServer({ key, cert }).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

# --- 1. key ---
$rsa = [System.Security.Cryptography.RSA]::Create(2048)

# --- 2. certificate request ---
$req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest(
    'CN=localhost',
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

$req.CertificateExtensions.Add(
    (New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension(
        $true, $false, 0, $true))
)
# NOTE: the -bor expression must stay on ONE line.
# Breaking it after the operator makes PowerShell parse "-bor" as a method call.
$keyUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
$req.CertificateExtensions.Add(
    (New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension($keyUsage, $true))
)

$san = New-Object System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
$san.AddDnsName('localhost')
# Also cover the loopback IP: the E2E server listens on 127.0.0.1, and a certificate
# without a matching IP SAN would fail with a hostname mismatch -- which would hide
# the thing we actually want to test (that a SELF-SIGNED certificate is the problem).
$san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
$req.CertificateExtensions.Add($san.Build())

$notBefore = [DateTimeOffset]::UtcNow.AddDays(-1)
$notAfter = [DateTimeOffset]::UtcNow.AddDays(2)
$cert = $req.CreateSelfSigned($notBefore, $notAfter)

# --- 3. PEM output ---
# [Convert]::ToBase64String with 'InsertLineBreaks' produces the 64-char wrapped
# layout that every PEM parser expects.
$keyB64 = [Convert]::ToBase64String($rsa.ExportPkcs8PrivateKey(), 'InsertLineBreaks')
$keyPem = "-----BEGIN PRIVATE KEY-----`n$keyB64`n-----END PRIVATE KEY-----`n"

$certB64 = [Convert]::ToBase64String(
    $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert),
    'InsertLineBreaks'
)
$certPem = "-----BEGIN CERTIFICATE-----`n$certB64`n-----END CERTIFICATE-----`n"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $OutDir 'key.pem'), $keyPem, $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $OutDir 'cert.pem'), $certPem, $utf8NoBom)

Write-Output ('CERT_OK ' + (Join-Path $OutDir 'cert.pem'))
