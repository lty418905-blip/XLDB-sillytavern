import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAuthorityBackup, restoreAuthorityBackup } from '../shared/src/scene/backup.ts';

const [command,...args]=process.argv.slice(2);
const root=fileURLToPath(new URL('../',import.meta.url));
const cli=path.join(root,'companion-agent','adapters','cli.mjs');

/**
 * Restore and recover take the database lease; an agent daemon serving that data directory must be stopped first.
 * A package without the agent (the tavern release) has no daemon to check.
 */
async function refuseActiveDaemon(databasePath) {
  const directory=path.dirname(path.resolve(databasePath));
  const protocol=path.join(root,'companion-agent','src','agent','daemon-protocol.ts');
  if(!fs.existsSync(directory)||!fs.existsSync(protocol))return;
  const { daemonPaths, daemonState, realDataDirectory }=await import(pathToFileURL(protocol).href);
  const dataDirectory=realDataDirectory(directory);
  if(!daemonState(daemonPaths(root,dataDirectory),{root,entryPath:cli,dataDirectory}).alive)return;
  const error=new Error('agent_daemon_active');
  error.hint=`Stop the agent daemon first: node companion-agent/adapters/cli.mjs daemon stop --data-directory "${directory}"`;
  throw error;
}

/**
 * The Agent companion tables of an agent database, loaded only when this package has them (the tavern release does
 * not); without it the restore still keeps the target's newer user controls, by table name.
 */
async function backupExtension() {
  const extension=path.join(root,'companion-agent','src','companion','backup-extension.ts');
  if(!fs.existsSync(extension))return undefined;
  return (await import(pathToFileURL(extension).href)).companionBackupExtension;
}

try {
  if(command==='create' && (args.length===1 || args.length===2)) {
    const result=await createAuthorityBackup(args[0],args[1]);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } else if(command==='restore' && args.length===2) {
    await refuseActiveDaemon(args[1]);
    process.stderr.write('Restore requires every XLDB core using this database to be stopped. The command will refuse an active database.\n');
    const result=await restoreAuthorityBackup(args[0],args[1],{extension:await backupExtension()});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } else if(command==='recover' && args.length===2) {
    await refuseActiveDaemon(args[1]);
    process.stderr.write('Disaster recovery writes backup-time state to a new path, or preserves a guarded corrupt target before replacement. Later deletions are preserved only when that target remains readable.\n');
    const result=await restoreAuthorityBackup(args[0],args[1],{mode:'recovery',extension:await backupExtension()});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } else {
    throw new Error('Usage: node tools/backup.mjs create DATABASE_PATH [OUTPUT_ROOT]\n       node tools/backup.mjs restore BACKUP_DIR DATABASE_PATH\n       node tools/backup.mjs recover BACKUP_DIR NEW_OR_CORRUPT_DATABASE_PATH');
  }
} catch(error) {
  process.stderr.write((error instanceof Error?error.message:String(error))+'\n');
  if(error?.hint)process.stderr.write(error.hint+'\n');
  process.exitCode=1;
}
