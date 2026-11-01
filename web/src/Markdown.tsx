import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { mobileLocalRequest } from './native/tauri-host';
import { ErrorNotice, useAction, useText } from './ui';

export interface MarkdownProps {
  text: string;
  /** 覆盖链接打开方式（桌面端 Tauri 没有 mobile 桥时传入）；缺省保持原 mobile 行为。 */
  onOpenLink?: (href: string) => void | Promise<unknown>;
}

export const Markdown = memo(function Markdown({text, onOpenLink}: MarkdownProps) {
  const action = useAction();
  const t = useText();
  const openLink = onOpenLink ?? ((href: string) => action.run(() => mobileLocalRequest('openCenter', {url: href})));
  return <div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
    a: ({href, children}) => <a href={href} onClick={event => { event.preventDefault(); if (href) void openLink(href); }}>{children}</a>,
    img: ({alt}) => <span className="secondary">{alt}</span>,
    pre: ({children}) => <pre tabIndex={0}>{children}</pre>,
    table: ({children}) => <div className="table-scroll" tabIndex={0} role="region" aria-label={t('可横向滚动表格', 'Scrollable table')}><table>{children}</table></div>,
  }}>{text}</ReactMarkdown><ErrorNotice error={action.error}/></div>;
});
