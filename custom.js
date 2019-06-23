/* global window, $ */

'use strict';

const {remote, shell} = require('electron');
const config = require('./config');

window.$ = require('jquery');
window.jQuery = require('jquery');
window.jQueryUI = require('jquery-ui');

$(function () {
    let window = remote.getCurrentWindow();

    $('#win-minimize').click(function () {
        window.minimize();
    });

    $('#win-maximize').click(function () {
        if (window.isMaximized()) {
            window.unmaximize();
        } else {
            window.maximize();
        }
    });

    $('#win-close').click(function () {
        window.close();
    });

    $('#youtube').click(function () {
        shell.openExternal('https://www.youtube.com/user/arsenalgrinch');
    });

    $('#discord').click(function () {
        shell.openExternal('https://discord.gg/EEkpKp2');
    });

    console.log(config.get('favoriteAnimal'));
});
