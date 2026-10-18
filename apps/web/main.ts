import { createApp } from 'vue';
import App from './App.vue';
import { installAntDesign } from './ant-design';
import './style.css';
import './calm.css';
import './ant-design.css';
const app = createApp(App);
installAntDesign(app);
app.mount('#app');
