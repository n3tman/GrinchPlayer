'use strict';
const path = require('path');
const {app, BrowserWindow} = require('electron');
// eslint-disable-next-line no-unused-vars
const cache = require('v8-compile-cache');
const {is} = require('electron-util');
const unhandled = require('electron-unhandled');
const debug = require('electron-debug');
const contextMenu = require('electron-context-menu');
const config = require('./config');

unhandled();
debug();
contextMenu();

// Note: Must match `build.appId` in package.json
app.setAppUserModelId('com.Nik.GrinchPlayer');
app.disableHardwareAcceleration();

// Set userData to current folder (portable app)
// app.setPath('userData', process.env.PORTABLE_EXECUTABLE_DIR + '/' + app.getName());

// Prevent variables from being garbage collected
let mainWindow;
const bounds = config.get('bounds') || {};

const createMainWindow = async () => {
    const appName = app.getName() + ' v' + app.getVersion();
    const iconPath = path.join(__dirname, 'static/icon-64.png');

    const win = new BrowserWindow({
        title: appName,
        show: false,
        frame: false,
        icon: iconPath,
        width: 1600,
        height: 1200,
        webPreferences: {
            nodeIntegration: true
        }
    });

    win.setBounds(bounds);

    win.on('ready-to-show', () => {
        win.show();
    });

    win.on('close', () => {
        config.set('bounds', win.getBounds());
    });

    win.on('closed', () => {
        // Dereference the window
        // For multiple windows store them in an array
        mainWindow = undefined;
    });

    await win.loadFile(path.join(__dirname, 'index.html'));

    return win;
};

app.on('window-all-closed', () => {
    if (!is.macos) {
        app.quit();
    }
});

app.on('activate', () => {
    if (!mainWindow) {
        mainWindow = createMainWindow();
    }
});

(async () => {
    await app.whenReady();
    mainWindow = await createMainWindow();
})();
