// Prints a fresh VAPID key pair for web push. Keep the private key secret; the public key is safe to share (the site hands it to browsers).
import webpush from 'web-push';
const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\nVAPID_SUBJECT=mailto:support@your-domain.example`);
