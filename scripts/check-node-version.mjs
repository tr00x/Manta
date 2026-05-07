import process from 'node:process';

const required = 20;
const major = parseInt(process.versions.node.split('.')[0], 10);

if (major < required) {
  console.error(
    `Manta requires Node >=${required}. Current: ${process.versions.node}. Use nvm or upgrade.`
  );
  process.exit(1);
}
