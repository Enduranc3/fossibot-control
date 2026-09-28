// Generates a SideStore/AltStore source for the IPA built in CI.
// SideStore rejects an install when size / version / buildVersion / bundle ID differ from the IPA,
// so every value here is taken from the actual build.
//
// usage: node scripts/make-source.mjs <ipa> <version> <build> <owner/repo> <tag> > source.json

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const [ipa, version, build, repo, tag] = process.argv.slice(2);
if (!ipa || !version || !build || !repo || !tag) {
  console.error('usage: make-source.mjs <ipa> <version> <build> <owner/repo> <tag>');
  process.exit(1);
}

const bundleIdentifier = 'app.fossicontrol.ios';
const [owner, name] = repo.split('/');
const size = statSync(ipa).size;
const sha256 = createHash('sha256').update(readFileSync(ipa)).digest('hex');
const date = new Date().toISOString();
const downloadURL = `https://github.com/${repo}/releases/download/${tag}/FossibotControl.ipa`;
const iconURL = `https://raw.githubusercontent.com/${repo}/main/resources/icon.png`;

const source = {
  name: 'Fossibot Control',
  identifier: `io.github.${owner.toLowerCase()}.${name.toLowerCase()}`,
  subtitle: 'Неофіційний клієнт для станцій Fossibot',
  iconURL,
  website: `https://github.com/${repo}`,
  tintColor: '#3fb950',
  apps: [
    {
      name: 'Fossibot Control',
      bundleIdentifier,
      developerName: owner,
      subtitle: 'Моніторинг і керування станцією',
      localizedDescription:
        'Неофіційний застосунок для Fossibot F1800/F3000: локальне підключення через Wi-Fi станції (TCP 8058) або через сервер Fossibot.',
      iconURL,
      tintColor: '#3fb950',
      category: 'utilities',
      versions: [
        {
          version,
          buildVersion: build,
          date,
          localizedDescription: `Збірка ${tag}`,
          downloadURL,
          size,
          sha256,
          minOSVersion: '15.0',
        },
      ],
      version,
      versionDate: date,
      downloadURL,
      size,
    },
  ],
  news: [],
};

process.stdout.write(JSON.stringify(source, null, 2) + '\n');
