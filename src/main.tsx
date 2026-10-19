import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { initExtensionErrorGuard } from './api/alipay'

// 初始化浏览器插件异常防护
initExtensionErrorGuard();

createRoot(document.getElementById("root")!).render(<App />);
