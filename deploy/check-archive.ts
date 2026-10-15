import {validateArchive} from '../server/platform/archive.js';
try{const result=await validateArchive(process.argv[2]);process.stdout.write(JSON.stringify(result)+'\n');}catch{process.stderr.write('发行归档路径、类型或大小校验失败\n');process.exitCode=1;}
