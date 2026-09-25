import { createAuthorityBackup, restoreAuthorityBackup } from '../src/scene/backup.ts';

const [command,...args]=process.argv.slice(2);

try {
  if(command==='create' && (args.length===1 || args.length===2)) {
    const result=await createAuthorityBackup(args[0],args[1]);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } else if(command==='restore' && args.length===2) {
    process.stderr.write('Restore requires every XLDB core using this database to be stopped. The command will refuse an active database.\n');
    const result=await restoreAuthorityBackup(args[0],args[1]);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } else if(command==='recover' && args.length===2) {
    process.stderr.write('Disaster recovery writes backup-time state to a new path, or preserves a guarded corrupt target before replacement. Later deletions are preserved only when that target remains readable.\n');
    const result=await restoreAuthorityBackup(args[0],args[1],{mode:'recovery'});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } else {
    throw new Error('Usage: node tools/backup.mjs create DATABASE_PATH [OUTPUT_ROOT]\n       node tools/backup.mjs restore BACKUP_DIR DATABASE_PATH\n       node tools/backup.mjs recover BACKUP_DIR NEW_OR_CORRUPT_DATABASE_PATH');
  }
} catch(error) {
  process.stderr.write((error instanceof Error?error.message:String(error))+'\n');
  process.exitCode=1;
}
