import type { CapacitorConfig } from '@capacitor/cli';

const serverUrl = process.env.CAPACITOR_SERVER_URL || 'http://localhost:3333';
const cleartext = serverUrl.startsWith('http://');

function getAllowedHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

const allowedHost = getAllowedHost(serverUrl);

const config: CapacitorConfig = {
  appId: 'com.weblist.app',
  appName: 'Weblist',
  webDir: 'dist',
  server: {
    url: serverUrl,
    cleartext,
    allowNavigation: allowedHost ? [allowedHost] : []
  },
  android: {
    backgroundColor: '#08090d',
    allowMixedContent: cleartext
  }
};

export default config;
