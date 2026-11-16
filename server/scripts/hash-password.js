// Usage: npm run hash-password -- 'your-password'
// Put the output in .env as ADMIN_PASSWORD_HASH='<hash>' (single quotes: the hash contains $).
import bcrypt from 'bcryptjs';

const pw = process.argv[2];
if (!pw || pw.length < 10) {
  console.error("Usage: npm run hash-password -- '<password of 10+ characters>'");
  process.exit(1);
}
console.log(bcrypt.hashSync(pw, 12));
