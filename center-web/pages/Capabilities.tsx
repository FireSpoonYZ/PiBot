import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Puzzle, RefreshCw, Sparkles, Wrench } from 'lucide-react';
import type { CapabilityKind, Installation, InstallSource, SkillVisibilityScope } from '@e-launcher/center-contract';

const VISIBILITY_SCOPE_LABELS: Record<SkillVisibilityScope, { label: string; badgeClass: string }> = {
  private: { label: '仅源 Bot 私有', badgeClass: 'badge-neutral' },
  assigned: { label: '指定 Bot 共享', badgeClass: 'badge-accent' },
  global: { label: '全局默认可用', badgeClass: 'badge-primary' },
};
import { api } from '../api';
import { ActivationBadge, activationUsable } from '../components/ActivationStatus';
import { ConfigOperation, errorMessage } from '../components/ConfigOperation';
import { SheetModal } from '../components/SheetModal';
import '../components/Config.css';

const KIND_META: Record<CapabilityKind, { label: string; badgeClass: string }> = {
  plugin: { label: '插件', badgeClass: 'badge-primary' },
  mcp: { label: 'MCP', badgeClass: 'badge-accent' },
  skill: { label: 'Skill', badgeClass: 'badge-neutral' },
};

function KindIcon({ kind }: { kind: CapabilityKind }) {
  if (kind === 'plugin') return <Puzzle size={16} aria-hidden="true" />;
  if (kind === 'mcp') return <Wrench size={16} aria-hidden="true" />;
  return <Sparkles size={16} aria-hidden="true" />;
}

export default function Capabilities() {
  const [items, setItems] = useState<Installation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filterKind, setFilterKind] = useState<'all' | CapabilityKind>('all');
  const [showPrivateLearned, setShowPrivateLearned] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);

  const [kind, setKind] = useState<CapabilityKind>('plugin');
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<InstallSource['type']>('npm');
  const [source, setSource] = useState('');
  const [file, setFile] = useState<File>();
  const [skillSlug, setSkillSlug] = useState('');
  const [skillDescription, setSkillDescription] = useState('');
  const [skillBody, setSkillBody] = useState('');
  const [target, setTarget] = useState<'center' | 'host'>('host');
  const [operation, setOperation] = useState('');
  const [rename, setRename] = useState<{ installationId: string; revision: number; name: string }>();

  const load = async () => {
    try {
      setItems(await api.listCapabilities());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const install = async () => {
    setBusy(true);
    setError('');
    try {
      let accepted;
      if (sourceType === 'inline') {
        const displayName = name.trim();
        if (!displayName) throw new Error('请填写显示名称');
        const slug = skillSlug.trim();
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
          throw new Error('技能标识名仅支持小写字母、数字、点、下划线或连字符，且须以小写字母或数字开头');
        }
        const desc = skillDescription.trim();
        if (!desc) throw new Error('请填写技能描述');
        const normalizedBody = skillBody.replace(/\r\n/g, '\n');
        if (!normalizedBody.trim()) throw new Error('请填写 SKILL.md 内容');
        const skillMd = normalizedBody.startsWith('---\n')
          ? normalizedBody
          : `---\nname: ${slug}\ndescription: ${JSON.stringify(desc)}\n---\n\n${normalizedBody}`;
        accepted = await api.install({
          requestId: crypto.randomUUID(),
          displayName,
          kind: 'skill',
          target: 'host',
          source: { type: 'inline', files: { 'SKILL.md': skillMd } },
          autoEnable: true,
        });
      } else {
        let input: InstallSource;
        if (sourceType === 'artifact') {
          if (!file) throw new Error('请选择制品文件');
          const uploaded = await api.uploadArtifact(file);
          input = { type: 'artifact', artifactRef: uploaded.artifactRef };
        } else {
          input = sourceType === 'http' ? { type: 'http', url: source } : { type: 'npm', spec: source };
        }
        accepted = await api.install({
          requestId: crypto.randomUUID(),
          displayName: name,
          kind,
          source: input,
          target,
        });
      }
      setOperation(accepted.operationId);
      setInstallOpen(false);
      setName('');
      setSource('');
      setFile(undefined);
      setSkillSlug('');
      setSkillDescription('');
      setSkillBody('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const renameInstallation = async () => {
    if (!rename) return;
    const displayName = rename.name.trim();
    if (!displayName) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api.renameInstallation(rename.installationId, {
        expectedRevision: rename.revision,
        displayName,
      });
      setItems(current =>
        current.map(item => (item.installationId === updated.installationId ? updated : item)),
      );
      setRename(undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleGlobal = async (item: Installation) => {
    if (item.enabled && !window.confirm('停用全局启用？保留各 Bot 绑定偏好，但立即停止执行。')) return;
    setBusy(true);
    setError('');
    try {
      if (item.enabled) await api.disableInstallation(item.installationId, { requestId: crypto.randomUUID() });
      else await api.enableInstallation(item.installationId, { requestId: crypto.randomUUID() });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const isPrivateLearned = (item: Installation) =>
    Boolean(item.ownerBot) && (item.visibilityScope ?? 'private') === 'private';
  const privateLearnedCount = items.filter(isPrivateLearned).length;
  const visibleItems = showPrivateLearned ? items : items.filter(item => !isPrivateLearned(item));
  const pluginCount = visibleItems.filter(item => item.kind === 'plugin').length;
  const mcpCount = visibleItems.filter(item => item.kind === 'mcp').length;
  const skillCount = visibleItems.filter(item => item.kind === 'skill').length;
  const visibleKinds: CapabilityKind[] = filterKind === 'all' ? ['plugin', 'mcp', 'skill'] : [filterKind];

  return (
    <main className="page config-page">
      <header className="page-header">
        <div className="page-title-group">
          <h1>插件、MCP 与 Skill</h1>
          <p className="secondary">安装实例由中心统一管理，每个 Bot 可独立启用与覆盖参数</p>
        </div>
        <button type="button" className="button secondary-button" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={16} aria-hidden="true" />
          刷新状态
        </button>
        <button type="button" className="button" onClick={() => setInstallOpen(true)}>
          <Plus size={18} aria-hidden="true" />
          安装或登记
        </button>
      </header>

      {error && (
        <p className="inline-error config-error" role="alert">
          {error}
        </p>
      )}

      {operation && <ConfigOperation key={operation} id={operation} onFinished={() => void load()} />}

      <div className="filter-bar" role="group" aria-label="能力类型筛选">
        <button
          type="button"
          className={`filter-chip ${filterKind === 'all' ? 'is-active' : ''}`}
          aria-pressed={filterKind === 'all'}
          onClick={() => setFilterKind('all')}
        >
          全部 ({visibleItems.length})
        </button>
        <button
          type="button"
          className={`filter-chip ${filterKind === 'plugin' ? 'is-active' : ''}`}
          aria-pressed={filterKind === 'plugin'}
          onClick={() => setFilterKind('plugin')}
        >
          插件 ({pluginCount})
        </button>
        <button
          type="button"
          className={`filter-chip ${filterKind === 'mcp' ? 'is-active' : ''}`}
          aria-pressed={filterKind === 'mcp'}
          onClick={() => setFilterKind('mcp')}
        >
          MCP ({mcpCount})
        </button>
        <button
          type="button"
          className={`filter-chip ${filterKind === 'skill' ? 'is-active' : ''}`}
          aria-pressed={filterKind === 'skill'}
          onClick={() => setFilterKind('skill')}
        >
          Skill ({skillCount})
        </button>
        {privateLearnedCount > 0 && (
          <button
            type="button"
            className={`filter-chip ${showPrivateLearned ? 'is-active' : ''}`}
            aria-pressed={showPrivateLearned}
            onClick={() => setShowPrivateLearned(prev => !prev)}
          >
            ✨ 含 Bot 私有习得技能 ({privateLearnedCount})
          </button>
        )}
      </div>

      {visibleKinds.map(type => {
        const groupItems = visibleItems.filter(item => item.kind === type);
        const meta = KIND_META[type];
        return (
          <section key={type} className="card-group">
            <div className="card-header">
              <h2>
                <KindIcon kind={type} /> {meta.label}
              </h2>
              <span className="badge badge-neutral">{groupItems.length}</span>
            </div>
            {groupItems.length === 0 ? (
              <p className="empty-state secondary">
                暂无已登记的 {meta.label} 实例
                {type === 'skill' && !showPrivateLearned && privateLearnedCount > 0
                  ? `（另有 ${privateLearnedCount} 个 Bot 私有习得技能，可点击上方筛选标签查看并修改共享范围）`
                  : ''}
                。
              </p>
            ) : (
              <div className="card-grid">
                {groupItems.map(item => {
                  const scopeMeta = item.ownerBot
                    ? VISIBILITY_SCOPE_LABELS[item.visibilityScope ?? 'private']
                    : undefined;
                  return (
                  <article key={item.installationId} className="resource-card resource-row">
                    <div className="card-header">
                      <Link to={`/capabilities/${encodeURIComponent(item.installationId)}`}>
                        <strong>{item.displayName}</strong>
                      </Link>
                      <div className="action-row">
                        <span className={`badge ${meta.badgeClass}`}>{meta.label}</span>
                        {item.ownerBot && (
                          <span className="badge badge-neutral">
                            ✨ Bot 习得 ({item.ownerBot.botId})
                          </span>
                        )}
                        {scopeMeta && (
                          <span className={`badge ${scopeMeta.badgeClass}`}>
                            {scopeMeta.label}
                          </span>
                        )}
                        <span className={`badge ${item.enabled ? 'badge-online' : 'badge-offline'}`}>
                          {item.enabled ? '启用' : '禁用'}
                        </span>
                        <ActivationBadge status={item.activation.status} />
                        {item.enabled && !activationUsable(item) && (
                          <span className="badge badge-warn">当前不生效</span>
                        )}
                        <span className="badge badge-neutral">
                          {item.target === 'center' ? '中心托管' : 'Host 执行'}
                        </span>
                        {item.kind !== 'skill' && (
                          <span className="badge badge-neutral">v{item.targetVersion}</span>
                        )}
                      </div>
                    </div>
                    <div className="action-row">
                      <span className="secondary">
                        {item.packageId} ·{' '}
                        {item.source.type === 'npm'
                          ? item.source.spec
                          : item.source.type === 'http'
                            ? item.source.url
                            : item.source.type === 'inline'
                              ? '在线编写'
                              : '本地制品'}
                        {item.ownerBot
                          ? ` · 源 Bot：${item.ownerBot.deviceId} / ${item.ownerBot.botId}`
                          : ''}
                        {item.kind === 'mcp'
                          ? ` · MCP 由${item.target === 'center' ? '中心' : '目标 Host'}访问 URL`
                          : ''}
                      </span>
                      <Link
                        className="quiet-button"
                        to={`/capabilities/${encodeURIComponent(item.installationId)}`}
                      >
                        {item.ownerBot ? '共享与详情 →' : '管理详情 →'}
                      </Link>
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={busy}
                        onClick={() => void toggleGlobal(item)}
                      >
                        {item.enabled ? '停用全局' : '全局启用'}
                      </button>
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={busy}
                        onClick={() =>
                          setRename({
                            installationId: item.installationId,
                            revision: item.revision,
                            name: item.displayName,
                          })
                        }
                      >
                        重命名
                      </button>
                    </div>
                    {item.activation.error && (
                      <p className="inline-error">
                        {item.activation.error.code}：{item.activation.error.message}
                      </p>
                    )}
                  </article>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      <SheetModal
        open={installOpen}
        onOpenChange={setInstallOpen}
        title="安装或登记能力"
        description="从 npm 包、本地制品文件或远程 HTTP MCP 端点安装与登记能力实例"
      >
        <form
          className="form"
          onSubmit={event => {
            event.preventDefault();
            void install();
          }}
        >
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <label>
            类型
            <select
              value={kind}
              onChange={event => {
                const next = event.target.value as CapabilityKind;
                setKind(next);
                if (next === 'skill') {
                  setSourceType('inline');
                  setTarget('host');
                } else {
                  if (next !== 'mcp') setTarget('host');
                  if (sourceType === 'inline' || (next !== 'mcp' && sourceType === 'http')) {
                    setSourceType('npm');
                  }
                }
              }}
            >
              <option value="plugin">插件</option>
              <option value="mcp">MCP</option>
              <option value="skill">Skill</option>
            </select>
          </label>
          <label>
            {sourceType === 'inline' ? '显示名称' : '名称'}
            <input
              required
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={sourceType === 'inline' ? '例如：部署助手' : '例如：GitHub MCP / 代码搜索插件'}
            />
          </label>
          <label>
            来源
            <select
              value={sourceType}
              onChange={event => setSourceType(event.target.value as InstallSource['type'])}
            >
              {kind === 'skill' ? (
                <>
                  <option value="inline">在线编写</option>
                  <option value="artifact">本地压缩包</option>
                  <option value="npm">npm</option>
                </>
              ) : (
                <>
                  <option value="npm">npm</option>
                  <option value="artifact">本地制品</option>
                  {kind === 'mcp' && <option value="http">HTTP MCP</option>}
                </>
              )}
            </select>
          </label>
          {sourceType === 'inline' ? (
            <>
              <label>
                技能标识名
                <input
                  required
                  pattern="[a-z0-9][a-z0-9._-]*"
                  value={skillSlug}
                  onChange={event => setSkillSlug(event.target.value)}
                  placeholder="例如：deploy-helper"
                />
                <small className="secondary">
                  仅支持小写字母、数字、点、下划线或连字符，需以小写字母或数字开头
                </small>
              </label>
              <label>
                技能描述
                <input
                  required
                  value={skillDescription}
                  onChange={event => setSkillDescription(event.target.value)}
                  placeholder="说明何时触发及技能用途（用于生成 frontmatter description）"
                />
              </label>
              <label>
                SKILL.md 内容
                <textarea
                  required
                  rows={12}
                  style={{ fontFamily: 'monospace' }}
                  value={skillBody}
                  onChange={event => setSkillBody(event.target.value)}
                  placeholder="直接编写 Markdown 正文，或粘贴带 --- frontmatter 的完整 SKILL.md"
                />
              </label>
            </>
          ) : sourceType === 'artifact' ? (
            <label>
              制品
              <input
                type="file"
                required
                onChange={event => setFile(event.target.files?.[0])}
              />
            </label>
          ) : (
            <label>
              {sourceType === 'http' ? 'HTTP URL' : 'npm 包及版本'}
              <input
                required
                value={source}
                onChange={event => setSource(event.target.value)}
                placeholder={sourceType === 'http' ? 'https://example.com/mcp' : '@scope/pkg@1.0.0'}
              />
            </label>
          )}
          {sourceType !== 'inline' && (
            <label>
              执行目标
              <select
                value={target}
                onChange={event => setTarget(event.target.value as 'center' | 'host')}
              >
                <option value="host">Host</option>
                {kind === 'mcp' && <option value="center">中心</option>}
              </select>
            </label>
          )}
          {kind === 'mcp' && (
            <p className="inline-notice secondary">
              MCP 运行位置：{target === 'center' ? '中心' : '目标 Host'}。MCP URL 由该运行位置访问，需在那里可达。
            </p>
          )}
          {sourceType === 'http' && (
            <p className="inline-notice secondary">HTTP MCP 只登记远程端点，不下载安装远程服务。</p>
          )}
          <div className="action-row">
            <button type="submit" className="button" disabled={busy}>
              提交安装
            </button>
            <button
              type="button"
              className="button secondary-button"
              disabled={busy}
              onClick={() => setInstallOpen(false)}
            >
              取消
            </button>
          </div>
        </form>
      </SheetModal>

      <SheetModal
        open={rename !== undefined}
        onOpenChange={open => {
          if (!open) setRename(undefined);
        }}
        title="重命名能力实例"
        description="只修改显示名称；安装标识、包 ID、工具名和执行内容不变，也不会触发重新部署。"
      >
        {rename && (
          <form
            className="form"
            onSubmit={event => {
              event.preventDefault();
              void renameInstallation();
            }}
          >
            <label>
              显示名称
              <input
                required
                maxLength={120}
                disabled={busy}
                value={rename.name}
                onChange={event => setRename({ ...rename, name: event.target.value })}
              />
            </label>
            <div className="action-row">
              <button type="submit" className="button" disabled={busy || !rename.name.trim()}>
                保存
              </button>
              <button
                type="button"
                className="quiet-button"
                disabled={busy}
                onClick={() => setRename(undefined)}
              >
                取消
              </button>
            </div>
          </form>
        )}
      </SheetModal>
    </main>
  );
}
