// center-server/cli.js
// Entry point. password-hash stays a standalone command. Normal startup
// resolves the bootstrap plan (legacy env, persisted center-config.json, or
// first-run onboarding) before any store is opened; setup mode serves a
// minimal onboarding listener, then swaps in the real center after the
// one-time submission persists the managed configuration.

import { setupPiHttpRuntime } from './http-dispatcher.js';
import { openCenterServer } from './server.js';
import { centerServerOptions, hashOwnerPassword, loadOrCreateSetupToken, resolveCenterPlan } from './config.js';
import { openSetupServer } from './setup.js';

setupPiHttpRuntime();

async function main() {
  if (process.argv[2] === 'password-hash') {
    let password = '';
    for await (const chunk of process.stdin) password += chunk;
    password = password.replace(/\r?\n$/, '');
    if (!password) throw new Error('Password must not be empty');
    process.stdout.write(hashOwnerPassword(password) + '\n');
    return;
  }
  if (process.argv.length !== 2) throw new Error('Unknown command');

  const plan = resolveCenterPlan(process.env);
  let listener;
  const stop = async () => {
    try { await listener?.close(); } finally { process.exit(0); }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  if (plan.mode === 'setup') {
    const setupToken = loadOrCreateSetupToken(plan.dataRoot);
    const setup = await openSetupServer({
      dataRoot: plan.dataRoot,
      tlsMode: 'proxy',
      listenHost: plan.listenHost,
      port: plan.port,
      webRoot: plan.webRoot,
      defaults: plan.setupDefaults,
      setupToken: setupToken.token,
    });
    listener = setup;
    process.stdout.write(
      'Center first-run setup required. Open ' + (plan.setupDefaults.publicUrl || setup.url)
      + ' and submit the one-time setup token from ' + setupToken.path
      + ' (also readable in this local log): ' + setupToken.token + '\n',
    );
    const configured = await setup.configured;
    listener = undefined;
    await setup.close();
    const server = await openCenterServer(centerServerOptions(plan, configured));
    listener = server;
    process.stdout.write('Center listening at ' + configured.publicUrl + '\n');
    return;
  }

  const server = await openCenterServer(centerServerOptions(plan, plan.config));
  listener = server;
  process.stdout.write('Center listening at ' + plan.config.publicUrl + '\n');
}

main().catch((error) => {
  process.stderr.write('Center startup failed: ' + (error && error.message ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
