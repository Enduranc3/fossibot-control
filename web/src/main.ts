import './styles.css';
import { boot } from './app.ts';
import { registerServiceWorker } from './pwa.ts';

void registerServiceWorker();
void boot(document.getElementById('app')!);
