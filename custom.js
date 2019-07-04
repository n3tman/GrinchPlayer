/* global window, $, requestAnimationFrame */

'use strict';

const {remote, shell} = require('electron');
const {dialog} = require('electron').remote;
const path = require('path');
const hp = require('howler');
const hotkeys = require('hotkeys-js');
const _ = require('lodash');
const fg = require('fast-glob');
// 1 const config = require('./config');

const editClass = 'has-bottom';
let blockDb = [];
let addedIds = [];
let lastPlayedIndex = -1;
let lastAddedIndex = -1;
let $currentBlock;

window.$ = require('jquery');
window.jQuery = require('jquery');
window.jQueryUI = require('jquery-ui-dist/jquery-ui');
window.sBar = require('simplebar');

// Check current mode
function isEditMode() {
    return $('body').hasClass(editClass);
}

// Toggle edit mode
function toggleEditMode() {
    $('body').toggleClass(editClass);
    $('#page-edit i').toggleClass('fa-edit fa-check-square-o');

    if (isEditMode()) {
        $('.sound-block').draggable('enable').resizable('enable');
    } else {
        $('.sound-block').draggable('disable').resizable('disable');
    }
}

// Initialize draggable/resizable block
function initDraggableMain($elements) {
    return $elements.draggable({
        grid: [10, 10],
        containment: 'parent',
        stack: '.sound-block',
        stop: function (e) {
            const id = e.target.dataset.id;
            blockDb[id].rect = getRectWithOffset(e.target);
        }
    }).resizable({
        grid: [10, 10],
        containment: 'parent',
        stop: function (e) {
            const id = e.target.dataset.id;
            blockDb[id].rect = getRectWithOffset(e.target);
        }
    }).mousedown(function (e) {
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
    if (addedIds.length > 0) {
        const rect = target.getBoundingClientRect();
        const targetId = Number(target.dataset.id);

        let collision = false;
        for (let id of addedIds) {
            const block = blockDb[id];

            if (targetId !== id) {
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
function autoPosition(block) {
    if (lastAddedIndex > -1) {
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
function addSoundBlock($element, position) {
    const id = Number($element.data('id'));
    const selector = '[data-id="' + id + '"]';
    const height = $element.outerHeight();

    $element.removeClass('panel-block').draggable('destroy')
        .addClass('button is-dark sound-block')
        .outerHeight(roundToTen(height));

    $('#main').append($element);

    const dropped = $(selector)[0];

    if (position === false) {
        autoPosition(dropped);
    } else {
        dropped.style.left = roundToTen(position.left) + 'px';
        dropped.style.top = roundToTen(position.top - 50) + 'px';
    }

    blockDb[id].rect = getRectWithOffset(dropped);
    addedIds.push(id);

    setTimeout(function () {
        initDraggableMain($(selector));
    }, 100);
}

// Add sound block to the deck
function addDeckItem(text, soundPath) {
    const id = blockDb.length;

    const html = '<a class="panel-block"' +
        ' data-id="' + id + '"><div class="sound-overlay"></div>' +
        '<div class="sound-text">' + text + '</div></a>';

    blockDb.push({
        howl: new hp.Howl({
            src: [soundPath],
            html5: true,
            preload: false,
            onplay: function () {
                requestAnimationFrame(updateAudioStep);
            }
        })
    });

    $(html).appendTo('#deck .simplebar-content').draggable({
        appendTo: 'body',
        revert: 'invalid',
        scroll: false,
        helper: 'clone'
    });
}

// Sets width of audio overlay
function setAudioOverlay(width) {
    $currentBlock.find('.sound-overlay').width(width);
}

// Play sound if it's not loaded
function playSound(element) {
    const id = element.dataset.id;
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
    $currentBlock = $(element);
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
function addFileBlocks(files) {
    files.forEach(function (file) {
        const parsed = path.parse(file);
        addDeckItem(parsed.name, file);
    });

    recalcScrollbars();
}

// Recalculate scrollbars
function recalcScrollbars() {
    $('[data-simplebar]').each(function (i, val) {
        val.SimpleBar.recalculate();
    });
}

// Round to nearest 10
function roundToTen(value) {
    return Math.ceil((value - 1) / 10) * 10;
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

    // Toggle Edit mode
    $('#page-edit').click(function () {
        toggleEditMode();
    });

    hotkeys('ctrl+space', function (event) {
        event.preventDefault();
        toggleEditMode();
    });

    // Deck toggle
    $('#deck-toggle').click(function () {
        const $body = $('body');
        const size = window.getSize();

        if ($body.hasClass('has-right')) {
            window.setSize(size[0] - 250, size[1]);
        } else {
            window.setSize(size[0] + 250, size[1]);
        }

        $body.toggleClass('has-right');
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
                addFileBlocks(files);
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

                    addFileBlocks(files);
                });
            }

            $main.removeClass('is-loading');
        });
    });

    // Main block
    $('#main').on('click', '.sound-block', function () {
        if (!isEditMode()) {
            playSound(this);
        }
    }).on('contextmenu', function () {
        const sound = blockDb[lastPlayedIndex];

        if (sound) {
            const howl = sound.howl;

            if (howl.playing()) {
                howl.pause();
            } else if (howl.seek() > 0) {
                howl.play();
            }
        }
    }).droppable({
        accept: '.panel-block',
        drop: function (e, ui) {
            addSoundBlock(ui.draggable, ui.position);
            recalcScrollbars();
        }
    });

    // Deck sidebar
    $('#deck').on('contextmenu', '.deck-items .panel-block', function () {
        playSound(this);
    }).on('click', '#batch-btn', function () {
        const num = $('#batch-num').val();
        const $items = $('.deck-items .panel-block');

        if (num > 0 && $items.length > 0) {
            $items.slice(0, num).each(function (i, elem) {
                const id = elem.dataset.id;
                addSoundBlock($(elem), false);
                lastAddedIndex = id;
            });

            lastAddedIndex = -1;
        }
    });
});
