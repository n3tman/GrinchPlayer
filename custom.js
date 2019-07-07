/* global window, $, requestAnimationFrame */

'use strict';

const {remote, shell} = require('electron');
const {dialog} = require('electron').remote;
const path = require('path');
const fs = require('fs');
const farmhash = require('farmhash');
const hp = require('howler');
const hotkeys = require('hotkeys-js');
const _ = require('lodash');
const fg = require('fast-glob');
const List = require('list.js');
// 1 const config = require('./config');

const editClass = 'has-bottom';
let blockDb = {};
let addedBlocks = [];
let lastPlayedHash = '';
let lastAddedHash = '';
let $currentBlock;
let deckList;

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
            const hash = e.target.dataset.hash;
            blockDb[hash].rect = getRectWithOffset(e.target);
        }
    }).resizable({
        grid: [10, 10],
        containment: 'parent',
        stop: function (e) {
            const hash = e.target.dataset.hash;
            blockDb[hash].rect = getRectWithOffset(e.target);
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
    if (addedBlocks.length > 0) {
        const rect = target.getBoundingClientRect();
        const targetHash = target.dataset.hash;

        let collision = false;
        for (let hash of addedBlocks) {
            const block = blockDb[hash];

            if (targetHash !== hash) {
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
    if (lastAddedHash.length > 0) {
        const lastRect = blockDb[lastAddedHash].rect;
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
    const hash = $element.data('hash');
    const selector = '[data-hash="' + hash + '"]';
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

    blockDb[hash].rect = getRectWithOffset(dropped);
    addedBlocks.push(hash);

    setTimeout(function () {
        initDraggableMain($(selector));
    }, 100);
}

// Append HTML of the idem to the deck
function appendDeckItemHtml(hash, text) {
    const html = '<a class="panel-block"' +
        ' data-hash="' + hash + '"><div class="sound-overlay"></div>' +
        '<div class="sound-text">' + text + '</div></a>';

    $(html).appendTo('#deck .simplebar-content').draggable({
        appendTo: 'body',
        revert: 'invalid',
        scroll: false,
        helper: 'clone'
    });
}

// Add sound block to the deck
function addDeckItem(soundPath) {
    const hash = getFileHash(soundPath);
    const text = path.parse(soundPath).name;

    if (hash in blockDb) {
        console.log('Пропущено: ' + soundPath);
    } else {
        blockDb[hash] = {
            hash: hash,
            text: text,
            howl: new hp.Howl({
                src: [soundPath],
                html5: true,
                preload: false,
                onplay: function () {
                    requestAnimationFrame(updateAudioStep);
                }
            })
        };

        appendDeckItemHtml(hash, text);
    }
}

// Sets width of audio overlay
function setAudioOverlay(width) {
    $currentBlock.find('.sound-overlay').width(width);
}

// Play sound if it's not loaded
function playSound(element) {
    const hash = element.dataset.hash;
    const howl = blockDb[hash].howl;

    if (lastPlayedHash.length > 0) {
        blockDb[lastPlayedHash].howl.stop();
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

    lastPlayedHash = hash;
    $currentBlock = $(element);
}

// Update block audio animation
function updateAudioStep() {
    const sound = blockDb[lastPlayedHash].howl;
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
        addDeckItem(file);
    });

    if (deckList === undefined) {
        deckList = new List('deck', {
            valueNames: ['sound-text'],
            listClass: 'simplebar-content'
        });
    }

    updateDeckData();
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

// Set deck counter value
function setDeckCounter() {
    const $deck = $('#deck');
    const $counter = $deck.find('.count');
    const $items = $deck.find('.deck-items .panel-block');
    $counter.text($items.length);
}

// Update deck items
function updateDeckData() {
    recalcScrollbars();
    setDeckCounter();
    deckList.reIndex();
}

// Get hex hash of a file
function getFileHash(path) {
    const file = fs.readFileSync(path);
    return Number(farmhash.hash64(file)).toString(16);
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

    // Remove all added blocks
    $('#remove-main').click(function () {
        if (addedBlocks.length > 0) {
            for (let hash of addedBlocks) {
                delete blockDb[hash].rect;
                $('[data-hash="' + hash + '"]').remove();
                appendDeckItemHtml(hash, blockDb[hash].text);
            }

            addedBlocks = [];
            updateDeckData();
        }
    });

    // Main block
    $('#main').on('click', '.sound-block', function () {
        if (!isEditMode()) {
            playSound(this);
        }
    }).on('contextmenu', function () {
        const sound = blockDb[lastPlayedHash];

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
            updateDeckData();
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
                const hash = elem.dataset.hash;
                addSoundBlock($(elem), false);
                lastAddedHash = hash;
            });

            lastAddedHash = '';
            updateDeckData();
        }
    }).on('click', '.sort', function () {
        const $this = $(this);
        const value = 'sound-text';
        const sortByLength = function (a, b) {
            const valA = a.elm.textContent.length;
            const valB = b.elm.textContent.length;
            return valA > valB ? 1 : valA < valB ? -1 : 0;
        };

        let order;

        $this.parent().find('.sort').removeClass('is-active');
        $this.addClass('is-active');

        if ($this.hasClass('by-length')) {
            if ($this.hasClass('asc')) {
                order = 'asc';
            } else {
                order = 'desc';
            }

            deckList.sort(value, {
                order: order,
                sortFunction: sortByLength
            });

            $this.addClass(order);
        }
    });
});
