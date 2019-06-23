/* global window, $ */

'use strict';

const {remote, shell} = require('electron');
const ryba = require('ryba-js');
const hotkeys = require('hotkeys-js');
const config = require('./config');

window.$ = require('jquery');
window.jQuery = require('jquery');
window.jQueryUI = require('jquery-ui-dist/jquery-ui');

function toggleEditMode() {
    const $body = $('body');
    const fixedClass = 'has-navbar-fixed-bottom';

    $body.toggleClass(fixedClass);
    $('#page-edit i').toggleClass('fa-edit fa-check-square-o');

    if ($body.hasClass(fixedClass)) {
        $('.draggable').draggable({grid: [10, 10]}).resizable({grid: [10, 10]});
    } else {
        $('.draggable').draggable('destroy').resizable('destroy');
    }
}

$(function () {
    let window = remote.getCurrentWindow();

    // Window controls
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

    // Navbar links
    $('#youtube').click(function () {
        shell.openExternal('https://www.youtube.com/user/arsenalgrinch');
    });

    $('#discord').click(function () {
        shell.openExternal('https://discord.gg/EEkpKp2');
    });

    // Page edit controls
    $('#page-edit').click(function () {
        toggleEditMode();
    });

    hotkeys('ctrl+space', function (event) {
        event.preventDefault();
        toggleEditMode();
    });

    $('#block-add').click(function () {
        const html = '<a class="button is-dark draggable ui-widget-content"><span class="text">' + ryba() + '</a></span>';
        $(html).appendTo('#main')
            .height(function () {
                return Math.ceil(this.offsetHeight / 10) * 10;
            })
            .draggable({grid: [10, 10]}).resizable({grid: [10, 10]});
    });

    // Debug
    console.log(config.get('favoriteAnimal'));
});
