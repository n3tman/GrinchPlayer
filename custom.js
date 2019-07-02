/* global window, document, $, requestAnimationFrame */

'use strict';

const {remote, shell} = require('electron');
const {dialog} = require('electron').remote;
const path = require('path');
const hp = require('howler');
const ryba = require('ryba-js');
const hotkeys = require('hotkeys-js');
const _ = require('lodash');
const fg = require('fast-glob');
const config = require('./config');

const fixedClass = 'has-navbar-fixed-bottom';
let blockDb = [];
let lastPlayedIndex = -1;
let lastAddedIndex = -1;
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
        initDraggable($('.draggable'));
    } else {
        $('.draggable').draggable('destroy').resizable('destroy');
    }
}

// Initialize draggable/resizable block
function initDraggable($elements) {
    return $elements.draggable({
        grid: [10, 10],
        stop: function (e) {
            const id = e.target.dataset.id;
            blockDb[id].rect = getRectWithOffset(e.target);
        }
    }).resizable({
        grid: [10, 10],
        stop: function (e) {
            const id = e.target.dataset.id;
            blockDb[id].rect = getRectWithOffset(e.target);
        }
    });
}

// Get block position, compensate navbar
function getRectWithOffset(element) {
    const rect = element.getBoundingClientRect();
    return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
    };
}

// Check block for collision with others
function isCollision(target) {
    if (blockDb.length > 0) {
        const rect = target.getBoundingClientRect();
        const targetId = Number(target.dataset.id);

        let collision = false;
        for (let block of blockDb) {
            if (blockDb[targetId] !== block) {
                collision = rect.right > block.rect.left &&
                    rect.left < block.rect.right &&
                    rect.bottom > block.rect.top &&
                    rect.top < block.rect.bottom;

                if (collision) {
                    break;
                }
            }
        }

        return collision;
    }

    return false;
}

// Automatically move block to free space
function autoPosition(block, batch) {
    if (batch && lastAddedIndex > -1) {
        const lastRect = blockDb[lastAddedIndex].rect;
        block.style.left = lastRect.left + 'px';
        block.style.top = lastRect.bottom - 60 + 'px';
    }

    do {
        block.style.top = block.offsetTop + 10 + 'px';

        if (block.getBoundingClientRect().bottom > window.innerHeight - 10) {
            block.style.top = 10 + 'px';
            block.style.left = block.offsetLeft + 200 + 'px';
        }
    } while (isCollision(block));
}

// Add a sound block
function addSoundBlock(text, soundPath, batch) {
    const id = blockDb.length;

    const html = '<a class="button is-dark draggable ui-widget-content"' +
        ' data-id="' + id + '"><div class="overlay"></div>' +
        '<span class="text">' + text + '</span></a>';

    $(html).appendTo('#main').height(function () {
        return Math.ceil(this.offsetHeight / 10) * 10;
    });

    const element = document.querySelector('[data-id="' + id + '"]');
    autoPosition(element, batch);

    if (batch) {
        lastAddedIndex = id;
    }

    const rect = getRectWithOffset(element);
    $(element).fadeTo('fast', 1);

    initDraggable($(element)).mousedown(function (e) {
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

    blockDb.push({
        rect: rect,
        howl: new hp.Howl({
            src: [soundPath],
            html5: true,
            preload: false,
            onplay: function () {
                requestAnimationFrame(updateAudioStep);
            }
        })
    });
}

// Sets width of audio overlay
function setAudioOverlay(width) {
    $currentBlock.find('.overlay').width(width);
}

// Update block audio animation
function updateAudioStep() {
    const sound = blockDb[lastPlayedIndex].howl;
    const seek = sound.seek() || 0;
    const width = (_.round((seek / sound.duration()) * 100, 3) || 0) + '%';

    setAudioOverlay(width);

    if (sound.playing()) {
        requestAnimationFrame(updateAudioStep);
    }
}

// Add multiple files as blocks
function addFileBlocks(files, batch) {
    files.forEach(function (file) {
        const parsed = path.parse(file);
        addSoundBlock(parsed.name, file, batch);
    });
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

    // Add block from single or multiple files
    $('#add-sound').click(function () {
        const $main = $('#main');
        $main.addClass('is-loading');

        dialog.showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            filters: [{name: 'Аудио (mp3, wav, ogg, flac)', extensions: ['mp3', 'wav', 'ogg', 'flac']}]
        }, function (files) {
            if (files !== undefined) {
                const batch = (files.length > 5);
                addFileBlocks(files, batch);
                lastAddedIndex = -1;
            }

            $main.removeClass('is-loading');
        });
    });

    // Add block from single or multiple files
    $('#add-folder').click(function () {
        const $main = $('#main');
        $main.addClass('is-loading');

        dialog.showOpenDialog({
            properties: ['openDirectory', 'multiSelections']
        }, function (dirs) {
            if (dirs !== undefined) {
                dirs.forEach(function (dir) {
                    const files = fg.sync('**/*.{mp3,wav,ogg,flac}', {
                        cwd: dir,
                        onlyFiles: true,
                        absolute: true
                    });

                    addFileBlocks(files, true);
                });

                lastAddedIndex = -1;
            }

            $main.removeClass('is-loading');
        });
    });

    // Audio
    $('#main').on('click', '.draggable', function () {
        if (!isEditMode()) {
            const id = this.dataset.id;
            const howl = blockDb[id].howl;

            if (lastPlayedIndex > -1) {
                blockDb[lastPlayedIndex].howl.stop();
                setAudioOverlay(0);
            }

            if (howl.state() === 'unloaded') {
                howl.load();
                howl.once('load', function () {
                    howl.play();
                });
            } else {
                howl.play();
            }

            lastPlayedIndex = id;
            $currentBlock = $(this);
        }
    }).on('contextmenu', function () {
        const sound = blockDb[lastPlayedIndex];

        if (!isEditMode() && sound) {
            const howl = sound.howl;

            if (howl.playing()) {
                howl.pause();
            } else if (howl.seek() > 0) {
                howl.play();
            }
        }
    });

    // Debug
    console.log(config.get('favoriteAnimal'));
});
