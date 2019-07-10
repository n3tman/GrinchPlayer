/* global window, document, $, requestAnimationFrame */

'use strict';

const {remote, shell} = require('electron');
const {dialog} = require('electron').remote;
const path = require('path');
const fs = require('fs');
const farmhash = require('farmhash');
const filenamify = require('filenamify');
const hp = require('howler');
const hotkeys = require('hotkeys-js');
const slugify = require('@sindresorhus/slugify');
const _ = require('lodash');
const fg = require('fast-glob');
const List = require('list.js');
const tippy = require('tippy.js/umd/index');
const config = require('./config');

const editClass = 'has-bottom';
const deckClass = 'has-right';
const audioExtensions = ['mp3', 'wav', 'ogg', 'flac'];
const howlDb = {};

let blockDb = {};
let addedBlocks = [];
let lastPlayedHash = '';
let lastAddedHash = '';
let $currentBlock;
let deckList;
let notifyHandle;

window.$ = require('jquery');
window.jQuery = require('jquery');
window.jQueryUI = require('jquery-ui-dist/jquery-ui');
window.sBar = require('simplebar');

// ================== //
//                    //
//   Main Functions   //
//                    //
// ================== //

// Show notification
function showNotification(text, error) {
    clearTimeout(notifyHandle);
    const $notify = $('.notification');

    $notify.removeClass('is-danger');
    if (error === true) {
        $notify.addClass('is-danger');
    }

    $notify.html(text).fadeIn();
    notifyHandle = setTimeout(function () {
        $notify.fadeOut();
    }, 4000);
}

// Toggle edit mode
function toggleEditMode() {
    const $blocks = $('.sound-block');
    $('body').toggleClass(editClass);
    $('#page-edit i').toggleClass('fa-edit fa-check-square-o');

    if (isEditMode()) {
        $blocks.draggable('enable').resizable('enable');
        $blocks.each(function () {
            this._tippy.enable();
        });
    } else {
        $blocks.draggable('disable').resizable('disable');
        $blocks.each(function () {
            this._tippy.disable();
        });
    }
}

// Initialize draggable/resizable block
function initDraggableMain($element) {
    $element.draggable({
        grid: [10, 10],
        containment: 'parent',
        stack: '.sound-block',
        start: function (e) {
            e.target._tippy.hide();
            e.target._tippy.disable();
        },
        stop: function (e) {
            const hash = e.target.dataset.hash;
            blockDb[hash].rect = getRectWithOffset(e.target);
            e.target._tippy.enable();
        }
    }).resizable({
        grid: [10, 10],
        containment: 'parent',
        start: function (e) {
            e.target._tippy.hide();
            e.target._tippy.disable();
        },
        stop: function (e) {
            const hash = e.target.dataset.hash;
            blockDb[hash].rect = getRectWithOffset(e.target);
            e.target._tippy.enable();
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
    }).on('wheel', function (e) {
        if (isEditMode()) {
            playSound(e.currentTarget);
        }
    });

    tippy($element[0], {
        content: '<div class="block-controls" data-for="' + $element.data('hash') + '">' +
            '<button class="button block-rename" title="Переименовать"><i class="fa fa-pencil" aria-hidden="true"></i></button>' +
            '<button class="button block-delete" title="Удалить"><i class="fa fa-times" aria-hidden="true"></i></button></div>',
        arrow: true,
        aria: null,
        interactive: true,
        interactiveBorder: 10,
        placement: 'right',
        boundary: document.querySelector('#main')
    });
}

// Check block for collision with others
function isCollision(target) {
    if (addedBlocks.length > 0) {
        const rect = target.getBoundingClientRect();
        const targetHash = target.dataset.hash;

        let collision = false;
        for (const hash of addedBlocks) {
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
    const mainWidth = $('#main').width();
    let success = true;

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

        if (block.getBoundingClientRect().right > mainWidth - 10) {
            success = false;
            break;
        }
    } while (isCollision(block));

    if (!success) {
        removeBlockFromPage(block.dataset.hash);
    }

    return success;
}

// Add a sound block from the deck
function addSoundBlockFromDeck($element, position) {
    const hash = $element.data('hash');
    const selector = '[data-hash="' + hash + '"]';
    const height = $element.outerHeight();
    let positioned;

    $element.removeClass('panel-block').draggable('destroy')
        .addClass('button is-dark sound-block')
        .outerHeight(roundToTen(height));

    $('#main').append($element);

    const dropped = $(selector)[0];

    if (position === false) {
        positioned = autoPosition(dropped);
    } else {
        dropped.style.left = roundToTen(position.left) + 'px';
        dropped.style.top = roundToTen(position.top - 50) + 'px';
        positioned = true;
    }

    if (positioned) {
        blockDb[hash].rect = getRectWithOffset(dropped);
        addedBlocks.push(hash);

        setTimeout(function () {
            initDraggableMain($(selector));
        }, 100);

        return true;
    }

    return false;
}

// Add a previously saved sound block to main div
function addSavedSoundBlock(hash) {
    const selector = '[data-hash="' + hash + '"]';
    const text = blockDb[hash].text;
    const rect = blockDb[hash].rect;

    const html = '<a class="button is-dark sound-block"' +
        ' data-hash="' + hash + '"><div class="sound-overlay"></div>' +
        '<div class="sound-text">' + text + '</div></a>';

    $(html).appendTo('#main').css({
        top: rect.top - 50,
        left: rect.left,
        height: rect.height,
        width: rect.width
    });

    initDraggableMain($(selector));
}

// Append HTML of the idem to the deck
function appendDeckItemHtml(hash, text) {
    const html = '<a class="panel-block"' +
        ' data-hash="' + hash + '"><div class="sound-overlay"></div>' +
        '<div class="sound-text">' + text + '</div></a>';

    $(html).prependTo('#deck .simplebar-content').draggable({
        appendTo: 'body',
        revert: 'invalid',
        scroll: false,
        helper: 'clone'
    });
}

// Init Howl object and add it to howlDB
function addInitHowl(hash, soundPath) {
    howlDb[hash] = new hp.Howl({
        src: [soundPath],
        html5: true,
        preload: false,
        onplay: function () {
            requestAnimationFrame(updateAudioStep);
        }
    });
}

// Add sound block to the deck
function addDeckItemFromFile(soundPath) {
    const hash = getFileHash(soundPath);
    const text = path.parse(soundPath).name;

    if ({}.hasOwnProperty.call(blockDb, hash)) {
        console.log(text + ' === ' + blockDb[hash].text + '\n----------\n');
    } else {
        blockDb[hash] = {
            hash: hash,
            text: text,
            path: path.win32.normalize(soundPath)
        };

        addInitHowl(hash, soundPath);
        appendDeckItemHtml(hash, text);
    }
}

// Play sound, load if it's not loaded
function playSound(element) {
    const hash = element.dataset.hash;
    const howl = howlDb[hash];

    stopCurrentSound();

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

// Add multiple files as blocks
function addFileBlocks(files) {
    const before = _.size(blockDb);

    files.forEach(function (file) {
        addDeckItemFromFile(file);
    });

    const added = _.size(blockDb) - before;
    const skipped = files.length - added;

    showNotification('Добавлено звуков: <b>' + added + '</b>. ' +
        'Пропущено: <b>' + skipped + '</b>');

    initDeckList();
    updateDeckData();
}

// Init deck list.js
function initDeckList() {
    if (deckList === undefined) {
        deckList = new List('deck', {
            valueNames: ['sound-text'],
            listClass: 'simplebar-content'
        });
    }
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

// Delete one block from the page
function removeBlockFromPage(hash) {
    delete blockDb[hash].rect;
    $('[data-hash="' + hash + '"]').remove();
    appendDeckItemHtml(hash, blockDb[hash].text);
    if (addedBlocks.includes(hash)) {
        _.pull(addedBlocks, hash);
    }
}

// Save all pages/projects/settings to config
function saveAllData() {
    if (addedBlocks.length > 0) {
        config.set('pages.123.added', addedBlocks);
    } else {
        config.delete('pages.123.added');
    }

    if (_.size(blockDb) > 0) {
        config.set('pages.123.blocks', blockDb);
    } else {
        config.delete('pages.123.blocks');
    }

    showNotification('Данные сохранены в базу!');
}

// Show a dialog for folder selection, return sounds
function showFolderSelectionDialog(callback, finish) {
    let files = [];

    dialog.showOpenDialog({
        title: 'Выберите папки со звуками',
        properties: ['openDirectory', 'multiSelections']
    }, function (dirs) {
        if (dirs === undefined) {
            finish();
        } else {
            dirs.forEach(function (dir) {
                files = files.concat(getAudioFilesInFolder(dir));
            });

            if (files.length > 0) {
                callback(files);
            }

            if (finish !== undefined) {
                finish();
            }
        }
    });
}

// Load saved page
function loadSavedPage(page) {
    if (page.blocks !== undefined && _.size(page.blocks) > 0) {
        blockDb = page.blocks;
    }

    if (page.added !== undefined && page.added.length > 0) {
        addedBlocks = page.added;
    }

    if (_.size(blockDb) > 0) {
        _.each(blockDb, function (block, hash) {
            if (addedBlocks.includes(hash)) {
                addSavedSoundBlock(hash);
            } else {
                appendDeckItemHtml(hash, block.text);
            }

            addInitHowl(hash, block.path);
        });

        initDeckList();
        updateDeckData();
    }
}

// ==================== //
//                      //
//   Helper Functions   //
//                      //
// ==================== //

// Check current mode
function isEditMode() {
    return $('body').hasClass(editClass);
}

// Check if deck is active
function isDeckActive() {
    return $('body').hasClass(deckClass);
}

// Sets width of audio overlay
function setAudioOverlay(width) {
    $currentBlock.find('.sound-overlay').width(width);
}

// Update block audio animation
function updateAudioStep() {
    const sound = howlDb[lastPlayedHash];
    if (sound !== undefined) {
        const seek = sound.seek() || 0;
        const width = (_.round((seek / sound.duration()) * 100, 3) || 0) + '%';

        setAudioOverlay(width);

        if (sound.playing()) {
            requestAnimationFrame(updateAudioStep);
        }
    }
}

// Stop current sound if it's playing
function stopCurrentSound() {
    if (lastPlayedHash.length > 0) {
        howlDb[lastPlayedHash].stop();
        setAudioOverlay(0);
    }
}

// Get block position
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

// Get hex hash of a file
function getFileHash(path) {
    const file = fs.readFileSync(path);
    return Number(farmhash.hash64(file)).toString(16);
}

// Get hex hash of a string
function getStringHash(text) {
    return Number(farmhash.hash64(text)).toString(16);
}

// Get files in folder by mask
function getAudioFilesInFolder(path) {
    return fg.sync('**/*.{' + audioExtensions.join(',') + '}', {
        cwd: path,
        caseSensitiveMatch: false,
        onlyFiles: true,
        absolute: true
    });
}

// Add hotkey, prevent default action
function addHotkey(keys, callback) {
    hotkeys(keys, function (e) {
        e.preventDefault();
        callback();
    });
}

// Slugify a string and return correct file name for a page
function getPageName(text) {
    return 'grinch-page_' + filenamify(slugify(text)) + '.json';
}

// Clear added blocks from main area
function flushAddedBlocks() {
    for (const hash of addedBlocks) {
        removeBlockFromPage(hash);
    }

    addedBlocks = [];
}

// Remove all deck items
function flushDeckItems() {
    _.keys(blockDb).forEach(function (hash) {
        if (!addedBlocks.includes(hash)) {
            howlDb[hash].unload();
            delete howlDb[hash];
            delete blockDb[hash];
            $('[data-hash="' + hash + '"]').remove();
        }
    });
}

// Prevent dragging/resizing of the main blocks
function freezeMainBlocks() {
    const $blocks = $('.sound-block');
    $blocks.draggable('disable').resizable('disable');
    $blocks.each(function () {
        this._tippy.disable();
    });
}

// Remove blocks without path from json
function filterBlocksWithoutPath(json) {
    _.keys(json.blocks).forEach(function (hash) {
        const block = json.blocks[hash];
        if (!{}.hasOwnProperty.call(block, 'path')) {
            delete json.blocks[hash];
            if (json.added.includes(hash)) {
                _.pull(json.added, hash);
            }
        }
    });

    return json;
}

// ================== //
//                    //
//   Global actions   //
//                    //
// ================== //

// Do actions before window is closed or reloaded
window.addEventListener('beforeunload', function () {
    saveAllData();
});

// ================================= //
//                                   //
//   Main action on document.ready   //
//                                   //
// ================================= //

$(function () {
    const mainWindow = remote.getCurrentWindow();
    const $body = $('body');
    const $main = $('#main');

    // Window controls
    $('#win-minimize').click(function () {
        mainWindow.minimize();
    });

    $('#win-maximize').click(function () {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    });

    $('#win-close').click(function () {
        mainWindow.close();
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

    // Load pages info from config
    if (_.size(config.get('pages')) > 0) {
        const page = config.get('pages.123');
        loadSavedPage(page);
        freezeMainBlocks();
    }

    // Deck toggle
    $('#deck-toggle').click(function () {
        const size = mainWindow.getSize();

        if ($body.hasClass('has-right')) {
            mainWindow.setSize(size[0] - 250, size[1]);
        } else {
            mainWindow.setSize(size[0] + 250, size[1]);
        }

        $body.toggleClass('has-right');
    });

    // Add block from single or multiple files
    $('#add-sound').click(function () {
        $main.addClass('is-loading');

        dialog.showOpenDialog({
            title: 'Выберите звуки',
            properties: ['openFile', 'multiSelections'],
            filters: [{
                name: 'Аудио: ' + audioExtensions.join(', '),
                extensions: audioExtensions
            }]
        }, function (files) {
            if (files === undefined) {
                $main.removeClass('is-loading');
            } else {
                addFileBlocks(files);
                $main.removeClass('is-loading');
            }
        });
    });

    // Add folder with sounds
    $('#add-folder').click(function () {
        $main.addClass('is-loading');

        showFolderSelectionDialog(function (files) {
            addFileBlocks(files);
        }, function () {
            $main.removeClass('is-loading');
        });
    });

    // Export current page to a file
    $('#page-export').click(function () {
        const pageName = 'Тестовая страница';
        const fileName = getPageName(pageName);

        $main.addClass('is-loading');

        dialog.showSaveDialog({
            title: 'Сохранить страницу в файл',
            defaultPath: fileName,
            filters: [{
                name: 'JSON',
                extensions: ['json']
            }]
        }, function (filePath) {
            if (filePath === undefined) {
                $main.removeClass('is-loading');
            } else {
                const json = {
                    type: 'page',
                    hash: getStringHash(pageName),
                    name: pageName
                };
                const blocks = {};

                if (addedBlocks.length > 0) {
                    json.added = addedBlocks;
                }

                if (_.size(blockDb) > 0) {
                    _.each(blockDb, function (block, hash) {
                        blocks[hash] = _.omit(block, 'path');
                    });
                    json.blocks = blocks;
                }

                fs.writeFileSync(filePath, JSON.stringify(json, null, '\t'), 'utf-8');
                $main.removeClass('is-loading');
                showNotification('Сохранено в <b>' + fileName + '</b>');
            }
        });
    });

    // Import a page from a file
    $('#page-import').click(function () {
        $main.addClass('is-loading');

        dialog.showOpenDialog({
            title: 'Выберите сохраненную страницу',
            properties: ['openFile'],
            filters: [{
                name: 'JSON',
                extensions: ['json']
            }]
        }, function (files) {
            if (files === undefined) {
                $main.removeClass('is-loading');
            } else {
                let json = JSON.parse(fs.readFileSync(files[0]));

                if (json.type && json.type === 'page' && files.length > 0) {
                    let counter = 0;
                    const filesNum = _.size(json.blocks);

                    showFolderSelectionDialog(function (files) {
                        for (const file of files) {
                            const hash = getFileHash(file);
                            if ({}.hasOwnProperty.call(json.blocks, hash)) {
                                json.blocks[hash].path = path.win32.normalize(file);
                                counter++;
                            }
                        }

                        json = filterBlocksWithoutPath(json);

                        if (counter > 0) {
                            flushAddedBlocks();
                            flushDeckItems();
                            loadSavedPage(json);
                        }
                    }, function () {
                        $main.removeClass('is-loading');
                        showNotification('Добавлено звуков: <b>' + counter + '</b>. ' +
                            'Пропущено: <b>' + (filesNum - counter) + '</b>');
                    });
                } else {
                    showNotification('Ошибка импортирования', true);
                }
            }
        });
    });

    // Remove all added blocks
    $('#remove-main').click(function () {
        if (addedBlocks.length > 0) {
            const count = addedBlocks.length;
            stopCurrentSound();
            flushAddedBlocks();
            updateDeckData();
            showNotification('Удалено со страницы: <b>' + count + '</b>');
        } else {
            showNotification('Удалять нечего o_O', true);
        }
    });

    // Save all pages and projects to DB
    $('#save-all').click(function () {
        saveAllData();
    });

    // ------------- //
    //  Body events  //
    // ------------- //

    $body.on('click', '.block-delete', function () {
        if (isEditMode()) {
            const hash = $(this).parent().data('for');
            const selector = '[data-hash="' + hash + '"]';
            $(selector)[0]._tippy.hide();
            removeBlockFromPage(hash);
            updateDeckData();
        }
    });

    // ------------ //
    //  Main block  //
    // ------------ //
    $main.on('click', '.sound-block', function () {
        if (!isEditMode()) {
            playSound(this);
        }
    }).on('contextmenu', function (e) {
        // Pause/play already playing sound
        if (!e.target.classList.contains('ui-resizable-handle')) {
            const sound = howlDb[lastPlayedHash];

            if (sound) {
                if (sound.playing()) {
                    sound.pause();
                } else if (sound.seek() > 0) {
                    sound.play();
                }
            }
        }
    }).droppable({
        accept: '.panel-block',
        drop: function (e, ui) {
            if (deckList.searched) {
                deckList.search();
                $('#deck').find('.search').val('').focus();
            }

            addSoundBlockFromDeck(ui.draggable, ui.position);
            updateDeckData();
        }
    });

    // -------------- //
    //  Deck sidebar  //
    // -------------- //
    $('#deck').on('contextmenu', '.deck-items .panel-block', function () {
        playSound(this);
    }).on('click', '#batch-btn', function () {
        // Batch add several blocks from the top
        const num = $('#batch-num').val();
        const $items = $('.deck-items .panel-block');
        let count = 0;

        if (num > 0 && $items.length > 0) {
            $items.slice(0, num).each(function (i, elem) {
                const hash = elem.dataset.hash;
                const success = addSoundBlockFromDeck($(elem), false);

                if (success) {
                    lastAddedHash = hash;
                    count++;
                } else {
                    return false;
                }
            });

            showNotification('Добавлено блоков: <b>' + count + '</b>');

            lastAddedHash = '';
            updateDeckData();
        } else {
            showNotification('Ошибка: нет числа или список пуст', true);
        }
    }).on('click', '.sort', function () {
        // Sort deck items
        if (deckList !== undefined) {
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
        }
    });

    // Unload and remove sounds from the deck
    $('#remove-deck').click(function () {
        if (_.size(blockDb) > 0) {
            const before = _.size(blockDb);
            stopCurrentSound();
            flushDeckItems();
            showNotification('Удалено из колоды: <b>' + (before - _.size(blockDb)) + '</b>');
            updateDeckData();
        } else {
            showNotification('Удалять нечего o_O', true);
        }
    });

    // ----------------------------- //
    //  Drag and drop files/folders  //
    // ----------------------------- //
    $('#deck, #controls').on('dragover', false).on('drop', function (e) {
        if (isEditMode() && e.originalEvent.dataTransfer !== undefined) {
            const files = e.originalEvent.dataTransfer.files;
            let fileArray = [];

            for (const file of files) {
                if (!file.type && file.size % 4096 === 0 &&
                    fs.lstatSync(file.path).isDirectory()) {
                    fileArray = fileArray.concat(getAudioFilesInFolder(file.path));
                } else {
                    const ext = file.name.split('.').pop().toLowerCase();
                    if (audioExtensions.includes(ext)) {
                        fileArray.push(file.path);
                    }
                }
            }

            if (fileArray.length > 0) {
                addFileBlocks(fileArray);
            }
        }
    });

    // --------- //
    //  HotKeys  //
    // --------- //

    // Toggle edit mode
    addHotkey('space', function () {
        if (isDeckActive()) {
            $('#deck-toggle').click();
        } else {
            toggleEditMode();
        }
    });

    // Toggle deck
    addHotkey('ctrl+space', function () {
        if (!isEditMode()) {
            toggleEditMode();
        }

        $('#deck-toggle').click();
    });

    // Save all data
    addHotkey('ctrl+s', function () {
        saveAllData();
    });
});
