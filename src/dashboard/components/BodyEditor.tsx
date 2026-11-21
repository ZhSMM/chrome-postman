/**
 * 请求体编辑器。
 *
 * 【支持的模式】
 *   none              不带 body
 *   json              application/json（带语法高亮）
 *   text / xml / html 纯文本类
 *   form-urlencoded   表单（键值对）
 *   form-data         multipart（可含文件）
 *   binary            二进制文件（存成 Base64）
 */
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { html } from '@codemirror/lang-html';
import { autocompletion } from '@codemirror/autocomplete';
import type { BodyConfig, BodyMode, MultipartPart } from '../../shared/types';
import type { CompletionSources } from '../../core/completion';
import { uid } from '../../shared/utils';
import KeyValueTable from './KeyValueTable';
import { useCodemirrorCompletion } from '../codemirror-completion';

interface Props {
  value: BodyConfig;
  onChange: (next: BodyConfig) => void;
  /** 补全候选源（变量、内置变量等） */
  sources?: CompletionSources;
}

const MODES: { value: BodyMode; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'xml', label: 'XML' },
  { value: 'html', label: 'HTML' },
  { value: 'form-urlencoded', label: 'x-www-form-urlencoded' },
  { value: 'form-data', label: 'form-data' },
  { value: 'binary', label: '二进制' },
];

/** 没有传 sources 时用的空候选源（避免每次渲染都新建对象） */
const EMPTY_SOURCES: CompletionSources = {
  variables: [],
  builtins: [],
  apis: [],
  headers: [],
  history: [],
};

export default function BodyEditor({ value, onChange, sources }: Props) {
  const body = value ?? { mode: 'none' as BodyMode, raw: '', form: [], formData: [] };

  /** 补全源（函数引用稳定，不会让编辑器重建） */
  const completionSource = useCodemirrorCompletion(sources ?? EMPTY_SOURCES);

  const patch = (part: Partial<BodyConfig>) => onChange({ ...body, ...part });

  /** 读取本地文件为 Base64（binary 模式用） */
  const handleFile = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    patch({
      binaryBase64: btoa(binary),
      binaryFileName: file.name,
      binaryMimeType: file.type || 'application/octet-stream',
    });
  };

  /** form-data：新增一个分段 */
  const addPart = (isFile: boolean) => {
    const part: MultipartPart = {
      id: uid('part'),
      key: '',
      value: '',
      isFile,
      enabled: true,
    };
    patch({ formData: [...(body.formData ?? []), part] });
  };

  const updatePart = (index: number, next: Partial<MultipartPart>) => {
    patch({
      formData: (body.formData ?? []).map((part, i) => (i === index ? { ...part, ...next } : part)),
    });
  };

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="muted">模式</span>
        <select
          className="select"
          value={body.mode}
          onChange={(e) => patch({ mode: e.target.value as BodyMode })}
        >
          {MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
        {body.mode === 'json' && (
          <button
            className="btn sm"
            title="把 JSON 格式化一下"
            onClick={() => {
              try {
                patch({ raw: JSON.stringify(JSON.parse(body.raw || '{}'), null, 2) });
              } catch {
                /* 格式不对就不动 */
              }
            }}
          >
            格式化
          </button>
        )}
      </div>

      {(body.mode === 'json' || body.mode === 'text' || body.mode === 'xml' || body.mode === 'html') && (
        <div className="body-editor">
          <CodeMirror
            value={body.raw ?? ''}
            height="100%"
            theme="dark"
            extensions={[
              body.mode === 'json'
                ? json()
                : body.mode === 'xml'
                  ? xml()
                  : body.mode === 'html'
                    ? html()
                    : [],
              // 用我们自己的补全源（变量、内置变量）替换 CodeMirror 默认的
              autocompletion({ override: [completionSource] }),
            ]}
            onChange={(val) => patch({ raw: val })}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: false,
              autocompletion: false,
            }}
          />
        </div>
      )}

      {body.mode === 'form-urlencoded' && (
        <KeyValueTable
          value={body.form ?? []}
          onChange={(form) => patch({ form })}
          keyPlaceholder="参数名"
          valuePlaceholder="参数值"
          emptyHint="还没有表单字段"
        />
      )}

      {body.mode === 'form-data' && (
        <div>
          <table className="kv-table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th style={{ width: '30%' }}>名称</th>
                <th>值 / 文件</th>
                <th style={{ width: 90 }}>类型</th>
                <th style={{ width: 32 }} />
              </tr>
            </thead>
            <tbody>
              {(body.formData ?? []).map((part, index) => (
                <tr key={part.id} className={part.enabled ? '' : 'row-disabled'}>
                  <td>
                    <button className="eye" onClick={() => updatePart(index, { enabled: !part.enabled })}>
                      {part.enabled ? '👁' : '🚫'}
                    </button>
                  </td>
                  <td>
                    <input
                      className="key"
                      value={part.key}
                      onChange={(e) => updatePart(index, { key: e.target.value })}
                    />
                  </td>
                  <td>
                    {part.isFile ? (
                      <span className="mono faint">{part.fileName ?? '未选择文件'}</span>
                    ) : (
                      <input
                        className="mono"
                        value={part.value}
                        onChange={(e) => updatePart(index, { value: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    <select
                      className="select"
                      value={part.isFile ? 'file' : 'text'}
                      onChange={(e) => {
                        const isFile = e.target.value === 'file';
                        updatePart(index, {
                          isFile,
                          fileName: isFile ? part.fileName ?? 'file' : undefined,
                          fileBase64: isFile ? part.fileBase64 : undefined,
                          mimeType: isFile ? part.mimeType : undefined,
                        });
                      }}
                    >
                      <option value="text">文本</option>
                      <option value="file">文件</option>
                    </select>
                  </td>
                  <td>
                    <button
                      className="btn ghost sm danger"
                      onClick={() =>
                        patch({ formData: (body.formData ?? []).filter((_, i) => i !== index) })
                      }
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="btn sm" onClick={() => addPart(false)}>
              + 文本字段
            </button>
            <button className="btn sm" onClick={() => addPart(true)}>
              + 文件字段
            </button>
          </div>

          {/* 文件选择器：为所有"文件"类型分段共用一个 input */}
          <input
            type="file"
            style={{ display: 'none' }}
            id="cp-multipart-file"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              const target = (body.formData ?? []).find((part) => part.isFile && !part.fileBase64);
              if (file && target) {
                const buffer = await file.arrayBuffer();
                const bytes = new Uint8Array(buffer);
                let binary = '';
                const chunk = 0x8000;
                for (let i = 0; i < bytes.length; i += chunk) {
                  binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
                }
                updatePart(
                  (body.formData ?? []).indexOf(target),
                  {
                    fileBase64: btoa(binary),
                    fileName: file.name,
                    mimeType: file.type || 'application/octet-stream',
                  },
                );
              }
              e.target.value = '';
            }}
          />
          {(body.formData ?? []).some((part) => part.isFile && !part.fileBase64) && (
            <button
              className="btn sm"
              style={{ marginTop: 8 }}
              onClick={() => document.getElementById('cp-multipart-file')?.click()}
            >
              选择文件…
            </button>
          )}
        </div>
      )}

      {body.mode === 'binary' && (
        <div>
          <input
            type="file"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) await handleFile(file);
            }}
          />
          {body.binaryFileName && (
            <div className="muted" style={{ marginTop: 8 }}>
              已选择：<span className="mono">{body.binaryFileName}</span>
              <span className="faint"> （{body.binaryMimeType}）</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
