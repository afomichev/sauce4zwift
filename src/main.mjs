import process from 'node:process';
import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import * as storage from './storage.mjs';
import * as menu from './menu.mjs';
import * as rpc from './rpc.mjs';
import {databases} from './db.mjs';
import * as Sentry from '@sentry/node';
import {Dedupe} from '@sentry/integrations';
import * as webServer from './webserver.mjs';
import * as stats from './stats.mjs';
import {beforeSentrySend, setSentry} from '../shared/sentry-util.mjs';
import {sleep} from '../shared/sauce/base.mjs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import * as secrets from './secrets.mjs';
import * as zwift from './zwift.mjs';
import * as windows from './windows.mjs';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const {autoUpdater} = require('electron-updater');
const electron = require('electron');
const isDEV = !electron.app.isPackaged;
const zwiftAPI = new zwift.ZwiftAPI();
const zwiftMonitorAPI = new zwift.ZwiftAPI();

let started;
let quiting;
let sentryAnonId;
let sauceApp;
const rpcSources = {
    windows: windows.eventEmitter,
};


function getConsoleSymbol(name) {
    /*
     * The symbols of functions in the console module are somehow not in the
     * global registry.  So we need to use this hack to get the real symbols
     * for monkey patching.
     */
    const symString = Symbol.for(name).toString();
    return Object.getOwnPropertySymbols(console).filter(x =>
        x.toString() === symString)[0];
}


function fmtLogDate(d) {
    const h = d.getHours().toString();
    const m = d.getMinutes().toString().padStart(2, '0');
    const s = d.getSeconds().toString().padStart(2, '0');
    const ms = d.getMilliseconds().toString().padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
}


function rotateLogFiles(limit=5) {
    const ud = electron.app.getPath('userData');
    const logs = fs.readdirSync(ud).filter(x => x.startsWith('sauce.log'));
    logs.sort((a, b) => a < b ? 1 : -1);
    while (logs.length > limit) {
        // NOTE: this is only for if we change the limit to a lower number
        // in a subsequent release.
        const fn = logs.shift();
        console.warn("Delete old log file:", fn);
        fs.unlinkSync(path.join(ud, fn));
    }
    let end = Math.min(logs.length, limit - 1);
    for (const fn of logs.slice(-(limit - 1))) {
        const newFn = `sauce.log.${end--}`;
        if (newFn === fn) {
            continue;
        }
        console.debug('Rotate log file:', fn, newFn);
        fs.renameSync(path.join(ud, fn), path.join(ud, newFn));
    }
}


function monkeyPatchConsoleInformant() {
    /*
     * This is highly Node specific but it maintains console logging,
     * devtools logging with correct file:lineno references, and allows
     * us to support file logging and logging windows.
     */
    process.env.TERM = 'dumb';  // Prevent color tty commands
    let curLogLevel;
    const descriptors = Object.getOwnPropertyDescriptors(console);
    const levels = {
        debug: 'debug',
        info: 'info',
        log: 'info',
        count: 'info',
        dir: 'info',
        warn: 'warn',
        assert: 'warn',
        error: 'error',
        trace: 'error',
    };
    for (const [fn, level] of Object.entries(levels)) {
        Object.defineProperty(console, fn, {
            enumerable: descriptors[fn].enumerable,
            get: () => (curLogLevel = level, descriptors[fn].value),
        });
    }
    const kWriteToConsoleSymbol = getConsoleSymbol('kWriteToConsole');
    const kWriteToConsoleFunction = console[kWriteToConsoleSymbol];
    const emitter = new EventEmitter();
    let seqno = 1;
    console[kWriteToConsoleSymbol] = function(useStdErr, message) {
        try {
            return kWriteToConsoleFunction.call(this, useStdErr, message);
        } finally {
            const o = {};
            const saveTraceLimit = Error.stackTraceLimit;
            Error.stackTraceLimit = 3;
            Error.captureStackTrace(o);
            Error.stackTraceLimit = saveTraceLimit;
            const stack = o.stack;
            const fileMatch = stack.match(/([^/\\: (]+:[0-9]+):[0-9]+\)?$/);
            if (!fileMatch) {
                debugger;
            }
            emitter.emit('message', {
                seqno: seqno++,
                date: new Date(),
                level: curLogLevel,
                message,
                file: fileMatch ? fileMatch[1] : null,
            });
        }
    };
    return emitter;
}
const logInformant = monkeyPatchConsoleInformant();
let _rotateErr;
try {
    rotateLogFiles();
} catch(e) {
    // Probably windows with anti virus. :/
    _rotateErr = e;
}
const _logFile = path.join(electron.app.getPath('userData'), 'sauce.log');
const _logFileStream = fs.createWriteStream(_logFile);
const _logQueue = [];
logInformant.on('message', o => {
    _logQueue.push(o);
    const time = fmtLogDate(o.date);
    const level = (`[${o.level.toUpperCase()}]`).padStart(5, ' ');
    _logFileStream.write(`${time} ${level} (${o.file}): ${o.message}\n`);
    if (_logQueue.length > 2000) {
        _logQueue.shift();
    }
});
rpcSources['logs'] = logInformant;
rpc.register(() => _logQueue, {name: 'getLogs'});
rpc.register(() => _logQueue.length = 0, {name: 'clearLogs'});
rpc.register(() => electron.shell.showItemInFolder(_logFile), {name: 'showLogInFolder'});
console.info("Sauce log file:", _logFile);
if (_rotateErr) {
    console.error('Log rotate error:', _rotateErr);
}


function quit(retcode) {
    quiting = true;
    if (retcode) {
        electron.app.exit(retcode);
    } else {
        electron.app.quit();
    }
}
rpc.register(quit);


function restart() {
    electron.app.relaunch();
    quit();
}
rpc.register(restart);


export function getApp() {
    return sauceApp;
}


try {
    storage.load(0);
} catch(e) {
    quiting = true;
    console.error('Storage error:', e);
    Promise.all([
        storage.reset(),
        electron.dialog.showErrorBox('Storage error. Resetting database...', '' + e)
    ]).finally(() => quit(1));
}

if (!isDEV) {
    setSentry(Sentry);
    Sentry.init({
        dsn: "https://df855be3c7174dc89f374ef0efaa6a92@o1166536.ingest.sentry.io/6257001",
        // Sentry changes the uncaught exc behavior to exit the process.  I think that's a bug
        // but this is the only workaround for now.
        integrations: data => [new Dedupe(), ...data.filter(x => x.name !== 'OnUncaughtException')],
        beforeSend: beforeSentrySend,
    });
    // No idea, just copied from https://github.com/getsentry/sentry-javascript/issues/1661
    global.process.on('uncaughtException', e => {
        const hub = Sentry.getCurrentHub();
        hub.withScope(async scope => {
            scope.setLevel('fatal');
            hub.captureException(e, {originalException: e});
        });
        console.error('Uncaught (but reported)', e);
    });
    Sentry.setTag('version', pkg.version);
    let id = storage.load('sentry-id');
    if (!id) {
        // It's just an anonymous value to distinguish errors and feedback
        id = crypto.randomBytes(16).toString("hex");
        storage.save('sentry-id', id);
    }
    Sentry.setUser({id});
    sentryAnonId = id;
} else {
    console.info("Sentry disabled by dev mode");
}


// Use non-electron naming for windows updater.
// https://github.com/electron-userland/electron-builder/issues/2700
electron.app.setAppUserModelId('io.saucellc.sauce4zwift'); // must match build.appId for windows
electron.app.on('window-all-closed', () => {
    if (started) {
        quit();
    }
});
electron.app.on('second-instance', (ev,_, __, {type}) => {
    if (type === 'quit') {
        console.warn("Another instance requested us to quit.");
        quit();
    }
});
electron.app.on('activate', async () => {
    // Clicking on the app icon..
    if (electron.BrowserWindow.getAllWindows().length === 0) {
        windows.openAllWindows();
    }
});
electron.app.on('before-quit', () => {
    quiting = true;
    Sentry.flush();
});
electron.ipcMain.on('subscribe', (ev, {event, domEvent, persistent, source='stats'}) => {
    const {win, activeSubs, spec} = windows.getMetaByWebContents(ev.sender);
    // NOTE: Electron webContents.send is incredibly hard ON CPU and GC for deep objects.  Using JSON is
    // a massive win for CPU and memory.
    const sendMessage = data => win.webContents.send('browser-message', {domEvent, json: JSON.stringify(data)});
    // NOTE: MacOS emits show/hide AND restore/minimize but Windows only does restore/minimize
    const resumeEvents = ['responsive', 'show', 'restore'];
    const suspendEvents = ['unresponsive', 'hide', 'minimize'];
    const shutdownEvents = ['destroyed', 'did-start-loading'];
    const emitter = rpcSources[source];
    if (!emitter) {
        throw new TypeError('Invalid emitter source: ' + source);
    }
    const listeners = [];
    function resume(who) {
        if (!activeSubs.has(event)) {
            if (who) {
                console.debug("Resume subscription:", event, spec.id, who);
            } else {
                console.debug("Startup subscription:", event, spec.id);
            }
            emitter.on(event, sendMessage);
            activeSubs.add(event);
        }
    }
    function suspend(who) {
        if (activeSubs.has(event)) {
            console.debug("Suspending subscription:", event, spec.id, who);
            emitter.off(event, sendMessage);
            activeSubs.delete(event);
        }
    }
    function shutdown() {
        emitter.off(event, sendMessage);
        for (const x of shutdownEvents) {
            win.webContents.off(x, shutdown);
        }
        for (const [name, cb] of listeners) {
            win.off(name, cb);
        }
        activeSubs.clear();
        // Must log last because of logs source which eats its own tail otherwise.
        console.debug("Shutdown subscription:", event, spec.id);
    }
    if (persistent || (win.isVisible() && !win.isMinimized())) {
        resume();
    }
    for (const x of shutdownEvents) {
        win.webContents.once(x, shutdown);
    }
    if (!persistent) {
        for (const x of resumeEvents) {
            const cb = ev => resume(x, ev);
            win.on(x, cb);
            listeners.push([x, cb]);
        }
        for (const x of suspendEvents) {
            const cb = ev => suspend(x, ev);
            win.on(x, cb);
            listeners.push([x, cb]);
        }
    }
});


rpc.register(() => isDEV, {name: 'isDEV'});
rpc.register(() => pkg.version, {name: 'getVersion'});
rpc.register(() => sentryAnonId, {name: 'getSentryAnonId'});
rpc.register(url => electron.shell.openExternal(url), {name: 'openExternalLink'});
rpc.register(() => sauceApp && sauceApp.webServerURL, {name: 'getWebServerURL'});
rpc.register(() => {
    return {
        main: {
            username: zwiftAPI.username,
            id: zwiftAPI.profile ? zwiftAPI.profile.id : null,
            authenticated: zwiftAPI.isAuthenticated(),
        },
        monitor: {
            username: zwiftMonitorAPI.username,
            id: zwiftMonitorAPI.profile ? zwiftMonitorAPI.profile.id : null,
            authenticated: zwiftMonitorAPI.isAuthenticated(),
        },
    };
}, {name: 'getZwiftLoginInfo'});
rpc.register(async id => {
    const key = {
        main: 'zwift-login',
        monitor: 'zwift-monitor-login',
    }[id];
    if (!id) {
        throw new TypeError('Invalid id for zwift logout');
    }
    await secrets.remove(key);
}, {name: 'zwiftLogout'});


async function ensureSingleInstance() {
    if (electron.app.requestSingleInstanceLock({type: 'probe'})) {
        return;
    }
    const {response} = await electron.dialog.showMessageBox({
        type: 'question',
        message: 'Another Sauce process detected.\n\nThere can only be one, you must choose...',
        buttons: ['Take the prize!', 'Run away'],
        noLink: true,
        cancelId: 1,
    });
    if (response === 1) {
        console.debug("Quiting due to existing instance");
        quit();
        return false;
    }
    let hasLock = electron.app.requestSingleInstanceLock({type: 'quit'});
    for (let i = 0; i < 10; i++) {
        if (hasLock) {
            return;
        }
        await sleep(500);
        hasLock = electron.app.requestSingleInstanceLock({type: 'quit'});
    }
    await electron.dialog.showErrorBox('Existing Sauce process hung',
        'Consider using Activity Monitor (mac) or Task Manager (windows) to find ' +
        'and stop any existing Sauce processes');
    quit(1);
    return false;
}


function registerRPCMethods(instance, ...methodNames) {
    for (const name of methodNames) {
        if (!instance[name]) {
            throw new TypeError('Invalid method name: ' + name);
        }
        rpc.register(instance[name].bind(instance), {name});
    }
}


async function getLocalRoutedIP() {
    const conn = net.createConnection(80, 'www.zwift.com');
    return await new Promise((resolve, reject) => {
        conn.on('connect', () => {
            try {
                resolve(conn.address().address);
            } finally {
                conn.end();
            }
        });
        conn.on('error', reject);
    });
}


class SauceApp extends EventEmitter {
    _defaultSettings = {
        webServerEnabled: true,
        webServerPort: 1080,
    };
    _settings;
    _settingsKey = 'app-settings';
    _metricsPromise;
    _lastMetricsTS = 0;

    constructor() {
        super();
        const _this = this;
        rpc.register(function() {
            _this._resetStorageState.call(_this, /*sender*/ this);
        }, {name: 'resetStorageState'});
        registerRPCMethods(this, 'getSetting', 'setSetting', 'pollMetrics', 'getDebugInfo',
            'getGameConnectionStatus');
    }

    getSetting(key, def) {
        if (!this._settings) {
            this._settings = storage.load(this._settingsKey) || {...this._defaultSettings};
        }
        if (!Object.prototype.hasOwnProperty.call(this._settings, key) && def !== undefined) {
            this._settings[key] = def;
            storage.save(this._settingsKey, this._settings);
        }
        return this._settings[key];
    }

    setSetting(key, value) {
        if (!this._settings) {
            this._settings = storage.load(this._settingsKey) || {...this._defaultSettings};
        }
        this._settings[key] = value;
        storage.save(this._settingsKey, this._settings);
        this.emit('setting-change', {
            key,
            value
        });
    }

    _getMetrics(reentrant) {
        return new Promise(resolve => setTimeout(() => {
            if (reentrant !== true) {
                // Schedule one more in anticipation of pollers
                this._metricsPromise = this._getMetrics(true);
            } else {
                this._metricsPromise = null;
            }
            this._lastMetricsTS = Date.now();
            resolve(electron.app.getAppMetrics());
        }, 2000 - (Date.now() - this._lastMetricsTS)));
    }

    async pollMetrics() {
        if (!this._metricsPromise) {
            this._metricsPromise = this._getMetrics();
        }
        return await this._metricsPromise;
    }

    async getDebugInfo() {
        return {
            app: {
                version: pkg.version,
                uptime: process.uptime(),
                mem: process.memoryUsage(),
                cpu: process.cpuUsage(),
                cwd: process.cwd(),
            },
            gpu: electron.app.getGPUFeatureStatus(),
            sys: {
                arch: process.arch,
                platform: os.platform(),
                release: os.release(),
                version: os.version(),
                productVersion: process.getSystemVersion(),
                mem: process.getSystemMemoryInfo(),
                uptime: os.uptime(),
                cpus: os.cpus(),
            },
            stats: this.statsProc.getDebugInfo(),
            databases: [].concat(...Array.from(databases.entries()).map(([dbName, db]) => {
                const stats = db.prepare('SELECT * FROM sqlite_schema WHERE type = ? AND name NOT LIKE ?')
                    .all('table', 'sqlite_%');
                return stats.map(t => ({
                    dbName,
                    tableName: t.name,
                    rows: db.prepare(`SELECT COUNT(*) as rows FROM ${t.name}`).get().rows,
                }));
            })),
        };
    }

    startGameConnectionServer(ip) {
        const gcs = new zwift.GameConnectionServer({ip, zwiftAPI});
        registerRPCMethods(gcs, 'watch', 'join', 'teleportHome', 'say', 'wave', 'elbow', 'takePicture',
            'changeCamera', 'enableHUD', 'disableHUD', 'chatMessage', 'reverse', 'toggleGraphs', 'sendCommands');
        gcs.start().catch(Sentry.captureException);
        return gcs;
    }

    async _resetStorageState(sender) {
        const {response} = await electron.dialog.showMessageBox(sender.getOwnerBrowserWindow(), {
            type: 'question',
            title: 'Confirm Reset State',
            message: 'This operation will reset all settings completely.\n\n' +
                'Are you sure you want continue?',
            buttons: ['Yes, reset to defaults', 'Cancel'],
            cancelId: 1,
        });
        if (response === 0) {
            console.warn('Reseting state and restarting...');
            await storage.reset();
            await secrets.remove('zwift-login');
            await secrets.remove('zwift-monitor-login');
            await electron.session.defaultSession.clearStorageData();
            await electron.session.defaultSession.clearCache();
            restart();
        }
    }

    getGameConnectionStatus() {
        return this.gameConnection && this.gameConnection.getStatus();
    }

    async start(options={}) {
        const gameMonitor = this.gameMonitor = new zwift.GameMonitor({
            zwiftMonitorAPI,
            gameAthleteId: zwiftAPI.profile.id,
        });
        this.statsProc = new stats.StatsProcessor({fakeData: options.fakeData, zwiftAPI, gameMonitor});
        this.statsProc.start();
        rpcSources.stats = this.statsProc;
        rpcSources.app = this;
        let ip;
        if (this.getSetting('gameConnectionEnabled')) {
            ip = ip || await getLocalRoutedIP();
            rpcSources.gameConnection = this.gameConnection = this.startGameConnectionServer(ip);
            // This isn't required but reduces latency..
            this.gameConnection.on('watch-command', id => gameMonitor.setWatching(id));
        } else {
            // Prevent errors for pages wanting this.
            rpcSources.gameConnection = new EventEmitter();
        }
        if (this.getSetting('webServerEnabled')) {
            ip = ip || await getLocalRoutedIP();
            this.webServerEnabled = true;
            this.webServerPort = this.getSetting('webServerPort');
            this.webServerURL = `http://${ip}:${this.webServerPort}`;
            // Will stall when there is a port conflict..
            webServer.start({
                ip,
                port: this.webServerPort,
                debug: isDEV,
                rpcSources,
                statsProc: this.statsProc,
            }).catch(Sentry.captureException);
        }
    }
}


async function zwiftAuthenticate(options) {
    let creds;
    const ident = options.ident;
    if (!options.forceLogin) {
        creds = await secrets.get(ident);
        if (creds) {
            try {
                await options.api.authenticate(creds.username, creds.password, options);
                console.info(`Using Zwift username [${ident}]:`, creds.username);
                return;
            } catch(e) {
                console.debug("Previous Zwift login invalid:", e);
                // We could remove them, but it might be a network error; just leave em for now.
            }
        }
    }
    creds = await windows.zwiftLogin(options);
    if (creds) {
        await secrets.set(ident, creds);
    } else {
        console.warn("Zwift login not active.  Things WILL BE BROKEN", zwiftAPI.isAuthenticated());
    }
}


export async function main() {
    if (quiting) {
        return;
    }
    const headless = process.argv.includes('--headless');
    sauceApp = new SauceApp();
    global.app = sauceApp;  // devTools debug XXX
    if (await ensureSingleInstance() === false) {
        return;
    }
    await electron.app.whenReady();
    if (!headless) {
        menu.installTrayIcon();
        menu.setAppMenu();
    }
    autoUpdater.checkForUpdatesAndNotify().catch(Sentry.captureException);
    const lastVersion = sauceApp.getSetting('lastVersion');
    if (lastVersion !== pkg.version) {
        if (!headless) {
            if (lastVersion) {
                console.info("Sauce recently updated");
                await electron.session.defaultSession.clearCache();
                await windows.showReleaseNotes();
            } else {
                console.info("First time invocation: Welcome to Sauce for Zwift");
                await windows.welcomeSplash();
            }
        }
        sauceApp.setSetting('lastVersion', pkg.version);
    }
    try {
        if (!await windows.eulaConsent() || !await windows.patronLink()) {
            return quit();
        }
    } catch(e) {
        await electron.dialog.showErrorBox('EULA or Patreon Link Error', '' + e);
        return quit(1);
    }
    const host = process.argv.find((x, i) => i && process.argv[i - 1] === '--host');
    const forceLogin = process.argv.includes('--force-login');
    await zwiftAuthenticate({
        api: zwiftAPI,
        ident: 'zwift-login',
        host,
        forceLogin,
    });
    await zwiftAuthenticate({
        api: zwiftMonitorAPI,
        ident: 'zwift-monitor-login',
        host,
        monitor: true,
        forceLogin,
    });
    await sauceApp.start({headless});
    if (!headless) {
        windows.openAllWindows();
        menu.updateTrayMenu();
    }
    started = true;
}

// Dev tools prototyping
global.zwift = zwift;
global.stats = stats;
global.zwiftAPI = zwiftAPI;
global.zwiftMonitorAPI = zwiftMonitorAPI;
