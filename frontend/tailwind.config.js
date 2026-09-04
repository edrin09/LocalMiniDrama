/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts}'],
  // 关闭 preflight：项目已有 theme.css 做基础重置，且 Element Plus 自带 base 样式，
  // 引入 preflight 会重置按钮/表单默认样式，破坏现有页面。
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
};
