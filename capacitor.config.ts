import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.fossicontrol.ios',
  appName: 'Fossibot Control',
  webDir: 'dist',
  backgroundColor: '#0d1117',
  ios: {
    contentInset: 'never',
    backgroundColor: '#0d1117',
    scrollEnabled: true,
  },
};

export default config;
