/* global window, $ */

'use strict';

const {remote, shell} = require('electron');
const {dialog} = require('electron').remote;
const path = require('path');
const hp = require('howler');
const ryba = require('ryba-js');
const hotkeys = require('hotkeys-js');
const config = require('./config');

const fixedClass = 'has-navbar-fixed-bottom';
let howlDb = [];
let howlIndex = -1;

window.$ = require('jquery');
window.jQuery = require('jquery');
window.jQueryUI = require('jquery-ui-dist/jquery-ui');

// Check current mode
function isEditMode() {
    return $('body').hasClass(fixedClass);
}

// Toggle edit mode
function toggleEditMode() {
    $('body').toggleClass(fixedClass);
    $('#page-edit i').toggleClass('fa-edit fa-check-square-o');

    if (isEditMode()) {
        $('.draggable').draggable({grid: [10, 10]}).resizable({grid: [10, 10]});
    } else {
        $('.draggable').draggable('destroy').resizable('destroy');
    }
}

// Add a sound block
function addSoundBlock(text, soundPath) {
    const id = howlDb.length + 1;
    const html = '<a class="button is-dark draggable ui-widget-content" data-id="' + id + '"><span class="text">' + text + '</a></span>';
    $(html).appendTo('#main')
        .height(function () {
            return Math.ceil(this.offsetHeight / 10) * 10;
        })
        .draggable({grid: [10, 10]}).resizable({grid: [10, 10]});

    if (soundPath) {
        howlDb.push(
            new hp.Howl({
                src: [soundPath]
            })
        );
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

    // Test block
    $('#add-block').click(function () {
        addSoundBlock(ryba(), './dist/sounds/привет.mp3');
    });

    // Block from audio file
    $('#add-sound').click(function () {
        dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{name: 'Аудио (mp3, wav, ogg, flac)', extensions: ['mp3', 'wav', 'ogg', 'flac']}]
        }, function (files) {
            if (files !== undefined) {
                const parsed = path.parse(files[0]);
                addSoundBlock(parsed.name, files[0]);
            }
        });
    });

    // Audio
    $('#main').on('click', '.draggable', function () {
        if (!isEditMode()) {
            const id = this.dataset.id - 1;

            if (howlIndex > -1) {
                howlDb[howlIndex].stop();
            }

            howlDb[id].play();
            howlIndex = id;
        }
    });

    // Debug
    console.log(config.get('favoriteAnimal'));
});
