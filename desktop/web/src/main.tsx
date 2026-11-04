// Module 17 desktop 入口：装配 App，加载样式；错误以可见状态呈现，不写原始日志。
import { createRoot } from 'react-dom/client';
import { createDesktopClient } from './api';
import './app.css';
import { DesktopApp } from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root container missing');
}
const api = createDesktopClient();
createRoot(container).render(<DesktopApp api={api} />);
