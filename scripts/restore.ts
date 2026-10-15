process.argv.splice(2, 0, 'restore');
await import('./manage.js');
export {};
