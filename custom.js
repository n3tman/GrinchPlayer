/* global window, $, requestAnimationFrame */

'use strict';

const {remote, shell} = require('electron');
const {dialog} = require('electron').remote;
const path = require('path');
const hp = require('howler');
const ryba = require('ryba-js');
const hotkeys = require('hotkeys-js');
const _ = require('lodash');
const config = require('./config');

const fixedClass = 'has-navbar-fixed-bottom';
let howlDb = [];
let howlIndex = -1;
let $currentBlock;

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

    const html = '<a class="button is-dark draggable ui-widget-content"' +
        'data-id="' + id + '"><div class="overlay"></div>' +
        '<span class="text">' + text + '</span></a>';

    $(html).appendTo('#main')
        .height(function () {
            return Math.ceil(this.offsetHeight / 10) * 10;
        })
        .draggable({grid: [10, 10]}).resizable({grid: [10, 10]})
        .mousedown(function (e) {
            if (e.which === 3 && isEditMode()) {
                const $target = $(e.currentTarget).find('.ui-resizable-se');
                const posX = $target.offset().left + 8;
                const posY = $target.offset().top + 8;

                $target.trigger({
                    type: 'mouseover', which: 1,
                    pageX: posX, pageY: posY
                }).trigger({
                    type: 'mousedown', which: 1,
                    pageX: posX, pageY: posY
                });
            }
        });

    if (soundPath) {
        howlDb.push(
            new hp.Howl({
                src: [soundPath],
                onplay() {
                    requestAnimationFrame(updateAudioStep);
                }
            })
        );
    }
}

// Sets width of audio overlay
function setAudioOverlay(width) {
    $currentBlock.find('.overlay').width(width);
}

// Update block audio animation
function updateAudioStep() {
    const sound = howlDb[howlIndex];
    const seek = sound.seek() || 0;
    const width = (_.round((seek / sound.duration()) * 100, 3) || 0) + '%';

    setAudioOverlay(width);

    if (sound.playing()) {
        requestAnimationFrame(updateAudioStep);
    }
}

// Main action on document.ready
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
                setAudioOverlay(0);
            }

            howlDb[id].play();
            howlIndex = id;
            $currentBlock = $(this);
        }
    }).on('contextmenu', function () {
        const sound = howlDb[howlIndex];

        if (!isEditMode() && sound) {
            if (sound.playing()) {
                sound.pause();
            } else if (sound.seek() > 0) {
                sound.play();
            }
        }
    });

    // Debug
    console.log(config.get('favoriteAnimal'));
});
