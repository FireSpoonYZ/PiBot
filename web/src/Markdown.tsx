import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { copyToClipboard } from './center-admin/primitives';
import { classifyMarkdownLink } from './markdownLink';
import { mobileLocalRequest } from './native/tauri-host';
import { ErrorNotice, useAction, useText } from './ui';
import './Markdown.css';

export interface MarkdownProps {
  text: string;
  /** 覆盖 HTTPS 网页打开方式（桌面端 Tauri 没有 mobile 桥时传入）。 */
  onOpenLink?: (href: string) => void | Promise<unknown>;
}

export const Markdown = memo(function Markdown({text, onOpenLink}: MarkdownProps) {
  const action = useAction();
  const t = useText();
  const [pathNotice, setPathNotice] = useState<{ path: string; copied?: boolean } | null>(null);
  const openLink = onOpenLink ?? ((href: string) => mobileLocalRequest('openCenter', {url: href}));

  function copyPath() {
    if (!pathNotice) return;
    void action.run(async () => {
      if (!await copyToClipboard(pathNotice.path)) {
        throw new Error(t('复制失败，可展开详情手动复制路径。', 'Could not copy. Expand the details to copy the path manually.'));
      }
      setPathNotice(current => current === pathNotice ? { ...pathNotice, copied: true } : current);
    });
  }

  return <div className="markdown">
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
      a: ({href, children}) => {
        const link = classifyMarkdownLink(href);
        if (!link) return <>{children}</>;
        if (link.kind === 'host-path') {
          return <button
            type="button"
            className="markdown-host-path"
            title={t('查看 Host 路径', 'Show Host path')}
            onClick={() => {
              action.setError('');
              setPathNotice({ path: link.path });
            }}
          >{children}</button>;
        }
        return <a href={link.href} onClick={event => {
          event.preventDefault();
          setPathNotice(null);
          void action.run(async () => { await openLink(link.href); });
        }}>{children}</a>;
      },
      img: ({alt}) => <span className="secondary">{alt}</span>,
      pre: ({children}) => <pre tabIndex={0}>{children}</pre>,
      table: ({children}) => <div className="table-scroll" tabIndex={0} role="region" aria-label={t('可横向滚动表格', 'Scrollable table')}><table>{children}</table></div>,
    }}>{text}</ReactMarkdown>
    {pathNotice && <ErrorNotice
      compact
      tone="info"
      title={t('这是 Host 路径，不是网页链接', 'This is a Host path, not a web link')}
      description={t('请在 Bot 所在的 Host 上查看，或请 Bot 把所需内容发到聊天里。', 'Open it on the Bot’s Host, or ask the Bot to send the relevant content in chat.')}
      detail={pathNotice.path}
      actionLabel={pathNotice.copied ? t('已复制', 'Copied') : t('复制路径', 'Copy path')}
      onAction={copyPath}
      onDismiss={() => {
        setPathNotice(null);
        action.setError('');
      }}
    />}
    <ErrorNotice error={action.error} />
  </div>;
});
