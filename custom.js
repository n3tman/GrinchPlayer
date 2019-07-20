/* global window, $, requestAnimationFrame */

'use strict';

const {remote, shell} = require('electron');
const {dialog} = require('electron').remote;
const path = require('path');
const fs = require('fs');
const farmhash = require('farmhash');
const filenamify = require('filenamify');
const hp = require('howler');
const hotkeys = require('hotkeys-js');
const iconvlite = require('iconv-lite');
const slugify = require('@sindresorhus/slugify');
const _ = require('lodash');
const fg = require('fast-glob');
const List = require('list.js');
const tippy = require('tippy.js/umd/index');
const config = require('./config');

const editClass = 'has-bottom';
const deckClass = 'has-right';
const sideClass = 'has-left';

const audioExtensions = ['mp3', 'wav', 'ogg', 'flac'];
const howlDb = {};

let allPages = config.get('pages') || {};
let activePages = {};
let lastPlayedHash = '';
let lastAddedHash = '';
let $currentBlock;
let deckList;
let notifyHandle;
let currentTab = config.get('currentTab') || '';
let $main;
let $tabList;

window.$ = require('jquery');
window.jQuery = require('jquery');
window.jQueryUI = require('jquery-ui-dist/jquery-ui');
window.sBar = require('simplebar');
window.jEditable = require('jquery-jeditable');

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
    const $tabs = $('#tabs .tab');

    toggleSidebarClasses(editClass);
    config.set('lastState.' + editClass, isEditMode());

    if (isEditMode()) {
        $blocks.draggable('enable').resizable('enable');
        $blocks.add($tabs).each(function () {
            this._tippy.enable();
        });
        $tabList.sortable('enable');
    } else {
        freezePageEditing($blocks, $tabs);
    }
}

// Initialize draggable/resizable block
function initDraggableMain($element) {
    const hash = $element.data('hash');

    $element.draggable({
        grid: [10, 10],
        containment: 'parent',
        stack: '.sound-block',
        scroll: false,
        start: function (e) {
            e.target._tippy.hide();
            e.target._tippy.disable();
        },
        stop: function (e) {
            const hash = e.target.dataset.hash;
            activePages[currentTab].blocks[hash].rect = getRectWithOffset(e.target);
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
            activePages[currentTab].blocks[hash].rect = getRectWithOffset(e.target);
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

    // Show tooltip with buttons in Edit mode
    tippy($element[0], {
        content: '<div class="block-controls" data-for="' + hash + '">' +
            '<button class="button block-rename" title="Переименовать"><i class="fa fa-pencil"></i></button>' +
            '<button class="button block-delete" title="Удалить"><i class="fa fa-times"></i></button></div>',
        arrow: true,
        aria: null,
        distance: 0,
        interactive: true,
        placement: 'right',
        boundary: $main[0]
    });

    // Make text editable in place on button click
    setTimeout(function () {
        const $text = $element.find('.sound-text');

        $text.editable(function (value) {
            return value.replace(/\s+/g, ' ').trim();
        }, {
            type: 'textarea',
            tooltip: null,
            event: 'edit',
            onblur: 'submit',
            width: '100%',
            onedit: function (settings) {
                settings.rows = _.round($text.height() / 18);
            },
            callback: function (value) {
                const textHeight = $text.outerHeight();
                const blockHeight = $element.outerHeight();

                if (textHeight > blockHeight) {
                    $element.outerHeight(roundToTen(textHeight));
                }

                activePages[currentTab].blocks[hash].rect = getRectWithOffset($element[0]);
                activePages[currentTab].blocks[hash].text = value;
            }
        });
    }, 300);
}

// Check block for collision with others
function isCollision(target, offsetTop, offsetLeft) {
    if (activePages[currentTab].added.length > 0) {
        const targetRect = target.getBoundingClientRect();
        const targetHash = target.dataset.hash;

        let collision = false;
        for (const hash of activePages[currentTab].added) {
            const block = activePages[currentTab].blocks[hash];

            if (targetHash !== hash) {
                collision = targetRect.right - offsetLeft > block.rect.left &&
                    targetRect.left - offsetLeft < block.rect.right &&
                    targetRect.bottom - offsetTop > block.rect.top &&
                    targetRect.top - offsetTop < block.rect.bottom;

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
    const mainWidth = $main.width();
    const mainHeight = $main.height() - $('#tabs').outerHeight();
    const offsetTop = getTopOffset();
    const offsetLeft = getLeftOffset();
    let success = true;

    if (lastAddedHash.length > 0) {
        const lastRect = activePages[currentTab].blocks[lastAddedHash].rect;
        block.style.left = lastRect.left + 'px';
        block.style.top = lastRect.bottom - 10 + 'px';
    }

    do {
        block.style.top = block.offsetTop + 10 + 'px';

        if (block.getBoundingClientRect().bottom - offsetTop > mainHeight - 10) {
            block.style.top = 10 + 'px';
            block.style.left = block.offsetLeft + 200 + 'px';
        }

        if (block.getBoundingClientRect().right - offsetLeft > mainWidth - 10) {
            success = false;
            break;
        }
    } while (isCollision(block, offsetTop, offsetLeft));

    if (!success) {
        removeBlockFromPage(block.dataset.hash);
    }

    return success;
}

// Add a sound block from the deck
function addSoundBlockFromDeck($element, position, offsetTop, offsetLeft) {
    const hash = $element.data('hash');
    const selector = '[data-hash="' + hash + '"]';
    const height = $element.find('.sound-text').outerHeight();
    let positioned;

    $element.removeClass('panel-block').draggable('destroy')
        .addClass('button is-dark sound-block')
        .outerHeight(roundToTen(height));

    $main.append($element);

    const dropped = $(selector)[0];

    if (position === false) {
        positioned = autoPosition(dropped);
    } else {
        dropped.style.left = roundToTen(position.left - offsetLeft - 10) + 'px';
        dropped.style.top = roundToTen(position.top - offsetTop - 10) + 'px';
        positioned = true;
    }

    if (positioned) {
        activePages[currentTab].blocks[hash].rect = getRectWithOffset(dropped);
        activePages[currentTab].added.push(hash);

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
    const text = activePages[currentTab].blocks[hash].text;
    const rect = activePages[currentTab].blocks[hash].rect;

    const html = '<a class="button is-dark sound-block"' +
        ' data-hash="' + hash + '"><div class="sound-overlay"></div>' +
        '<div class="sound-text">' + text + '</div></a>';

    $(html).appendTo($main).css({
        top: rect.top,
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

    if ({}.hasOwnProperty.call(activePages[currentTab].blocks, hash)) {
        console.log(text + ' === ' + activePages[currentTab].blocks[hash].text + '\n----------\n');
    } else {
        activePages[currentTab].blocks[hash] = {
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
    const before = _.size(activePages[currentTab].blocks);

    files.forEach(function (file) {
        addDeckItemFromFile(file);
    });

    const added = _.size(activePages[currentTab].blocks) - before;
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
    delete activePages[currentTab].blocks[hash].rect;
    $('[data-hash="' + hash + '"]').remove();
    appendDeckItemHtml(hash, activePages[currentTab].blocks[hash].text);
}

// Save all pages/projects/settings to config
function saveAllData() {
    const activeTabs = $('#tabs .tab').map(function () {
        return this.dataset.page;
    }).get();

    activeTabs.forEach(function (hash) {
        config.set('pages.' + hash, activePages[hash]);
    });

    config.set('activeTabs', activeTabs);

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
    const hash = page.hash;
    const tabHtml = $(getTabHtml(page.name, hash));

    activePages[hash] = page;
    $tabList.append(tabHtml);
    initNewPageBlocks(hash);

    if (page.blocks !== undefined && _.size(page.blocks) > 0) {
        activePages[currentTab].blocks = page.blocks;
    }

    if (page.added !== undefined && page.added.length > 0) {
        activePages[currentTab].added = page.added;
    }

    if (_.size(activePages[currentTab].blocks) > 0) {
        _.each(activePages[currentTab].blocks, function (block, hash) {
            if (activePages[currentTab].added.includes(hash)) {
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

// Add new empty page
function addNewEmptyPage($element) {
    const text = 'Таб#' + getRandomString(5);
    const hash = getStringHash(text);
    const tabHtml = $(getTabHtml(text, hash));

    if ($element === undefined) {
        $tabList.append(tabHtml);
    } else {
        $element.after(tabHtml);
    }

    initNewPageBlocks(hash);

    activePages[hash] = {
        hash: hash,
        name: text,
        added: [],
        blocks: {}
    };
}

// Init everything for a new page
function initNewPageBlocks(hash) {
    const selector = '[data-page="' + hash + '"]';
    const tabSelector = '.tab' + selector;
    const mainSelector = '.main' + selector;

    $('#controls').before('<div class="main" data-page="' + hash + '">');
    if (currentTab === hash) {
        $main = $(mainSelector);
    }

    initTabTooltip($(tabSelector)[0]);
    initEditableTab($(tabSelector));
    $tabList.sortable('refresh');
    reorderTabs();

    $(mainSelector).on('click', '.sound-block', function () {
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
            const offsetTop = getTopOffset();
            const offsetLeft = getLeftOffset();

            if (deckList.searched) {
                deckList.search();
                $('#deck-search').val('').focus();
            }

            addSoundBlockFromDeck(ui.draggable, ui.position, offsetTop, offsetLeft);
            updateDeckData();
        }
    });
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

// Check if left sidebar is active
function isSideActive() {
    return $('body').hasClass(sideClass);
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
    const offsetTop = getTopOffset();
    const offsetLeft = getLeftOffset();

    return {
        left: rect.left - offsetLeft,
        top: rect.top - offsetTop,
        right: rect.right - offsetLeft,
        bottom: rect.bottom - offsetTop,
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
    return Math.ceil(value / 10) * 10;
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
    activePages[currentTab].added.forEach(function (hash) {
        removeBlockFromPage(hash);
    });

    lastPlayedHash = '';
    activePages[currentTab].added = [];
}

// Remove all deck items
function flushDeckItems() {
    _.keys(activePages[currentTab].blocks).forEach(function (hash) {
        if (!activePages[currentTab].added.includes(hash)) {
            howlDb[hash].unload();
            delete howlDb[hash];
            delete activePages[currentTab].blocks[hash];
            $('[data-hash="' + hash + '"]').remove();
        }
    });

    lastPlayedHash = '';
}

// Prevent dragging/resizing of the main blocks
function freezePageEditing(blocks, tabs) {
    const $blocks = blocks || $('.sound-block');
    const $tabs = tabs || $('#tabs .tab');

    $blocks.draggable('disable').resizable('disable');
    $blocks.add($tabs).each(function () {
        this._tippy.hide();
        this._tippy.disable();
    });

    $tabList.sortable('disable');
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

// Get height of all the top blocks
function getTopOffset() {
    return $('#header').outerHeight() + $('#tabs').outerHeight();
}

// Get height of all the bottom blocks
function getLeftOffset() {
    return isSideActive() ? 250 : 0;
}

// Toggle sidebar classes
function toggleSidebarClasses(name) {
    const $body = $('body');

    switch (name) {
        case editClass:
            $('#page-edit .fa').toggleClass('fa-edit fa-check-square-o');
            break;
        case sideClass:
            $('#left-toggle .fa').toggleClass('fa-chevron-left fa-chevron-right');
            break;
        default:
        //
    }

    $body.toggleClass(name);
}

// Update numbers in tabs
function reorderTabs() {
    $('#tabs .tab').each(function (index) {
        $(this).find('strong').text(index + 1);
    });
}

// Return HTML code for a tab
function getTabHtml(text, hash) {
    return '<li class="tab" data-page="' + hash + '">' +
        '<a class="link"><span class="icon fa-stack">' +
        '<i class="fa fa-circle fa-stack-2x"></i>' +
        '<strong class="fa-stack-1x">1</strong></span>' +
        '<span class="text">' + text + '</span></a></li>';
}

// Show tab tooltips in Edit mode
function initTabTooltip(element) {
    const hash = element.dataset.page;

    tippy(element, {
        content: '<div class="tab-controls" data-for="' + hash + '">' +
            '<button class="button tab-delete" title="Удалить"><i class="fa fa-minus-square"></i></button>' +
            '<button class="button tab-rename" title="Переименовать"><i class="fa fa-pencil-square"></i></button>' +
            '<button class="button tab-add" title="Добавить справа"><i class="fa fa-plus-square"></i></button></div>',
        arrow: true,
        aria: null,
        distance: 0,
        interactive: true,
        placement: 'bottom'
    });
}

// Make tab text editable
function initEditableTab($tab) {
    $tab.find('.text').editable(function (value) {
        return value.replace(/\s+/g, ' ').trim();
    }, {
        type: 'textarea',
        tooltip: null,
        rows: 1,
        event: 'edit',
        onblur: 'submit',
        onedit: function (settings, element) {
            settings.cols = element.innerText.length + 5;
        },
        callback: function (value) {
            console.log(value);
        }
    });
}

// Get a random short string
function getRandomString(length) {
    return getStringHash(_.random(1000000).toString()).slice(0, length);
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
    $tabList = $('#tabs ul');

    const lastState = config.get('lastState') || {};
    [editClass, deckClass, sideClass].forEach(function (className) {
        if ({}.hasOwnProperty.call(lastState, className) && lastState[className] === true) {
            toggleSidebarClasses(className);
        }
    });

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

    // Tabs
    $tabList.sortable({
        cancel: '',
        scroll: false,
        tolerance: 'pointer',
        start: function (event, ui) {
            ui.item[0]._tippy.hide();
        },
        stop: function () {
            reorderTabs();
        }
    }).on('click', '.tab', function (e) {
        // Tab change event
        currentTab = e.currentTarget.dataset.page;
        config.set('currentTab', currentTab);
        $('.main').hide();
        $main = $('.main[data-page="' + currentTab + '"]');
        $main.show();
        $(e.delegateTarget).find('.is-active').removeClass('is-active');
        $(e.currentTarget).addClass('is-active');
    });

    // Load pages info from config
    const tabs = config.get('activeTabs');
    if (tabs.length > 0) {
        tabs.forEach(function (hash) {
            loadSavedPage(allPages[hash]);
        });
    } else {
        addNewEmptyPage();
    }

    // Click current tab if it's saved in the config
    setTimeout(function () {
        if (currentTab.length > 0) {
            $tabList.find('[data-page="' + currentTab + '"]').click();
        } else {
            $tabList.find('li:first').click();
        }
    }, 100);

    // Freeze editing if not in Edit mode
    if (!isEditMode()) {
        freezePageEditing();
    }

    // Deck toggle
    $('#deck-toggle').click(function () {
        const size = mainWindow.getSize();

        toggleSidebarClasses(deckClass);
        config.set('lastState.' + deckClass, isDeckActive());

        if (isDeckActive()) {
            mainWindow.setSize(size[0] + 250, size[1]);
        } else {
            mainWindow.setSize(size[0] - 250, size[1]);
        }
    });

    // Toggle left sidebar
    $('#left-toggle').click(function () {
        const size = mainWindow.getSize();
        const position = mainWindow.getPosition();

        toggleSidebarClasses(sideClass);
        config.set('lastState.' + sideClass, isSideActive());

        if (isSideActive()) {
            mainWindow.setPosition(position[0] - 250, position[1]);
            mainWindow.setSize(size[0] + 250, size[1]);
        } else {
            mainWindow.setPosition(position[0] + 250, position[1]);
            mainWindow.setSize(size[0] - 250, size[1]);
        }
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

                if (activePages[currentTab].added.length > 0) {
                    json.added = activePages[currentTab].added;
                }

                if (_.size(activePages[currentTab].blocks) > 0) {
                    _.each(activePages[currentTab].blocks, function (block, hash) {
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
        if (activePages[currentTab].added.length > 0) {
            const count = activePages[currentTab].added.length;
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

    // Import one PPv2 file
    $('#add-pp').click(function () {
        $main.addClass('is-loading');

        dialog.showOpenDialog({
            title: 'Выберите файл prank.txt из PrankPlayer v2',
            properties: ['openFile'],
            filters: [{
                name: 'prank.txt (PPv2)',
                extensions: ['txt']
            }]
        }, function (files) {
            if (files === undefined) {
                $main.removeClass('is-loading');
            } else {
                const file = iconvlite.decode(fs.readFileSync(files[0]), 'win1251');
                const parsed = path.parse(files[0]);
                const pageName = path.basename(parsed.dir);
                const lines = file.split(/\r?\n/);
                let lineNum = 0;
                let counter = 0;

                const page = {
                    type: 'page',
                    hash: getStringHash(pageName),
                    name: pageName,
                    added: [],
                    blocks: {}
                };

                lines.forEach(function (line, i) {
                    if (i !== 0 && line.trim().length > 0) {
                        const parts = line.split('*');
                        const filePath = parsed.dir + '\\' + parts[0];
                        lineNum++;

                        if (fs.existsSync(filePath)) {
                            const hash = getFileHash(filePath);

                            if (!{}.hasOwnProperty.call(page.blocks, hash)) {
                                const left = Number(parts[1]);

                                counter++;

                                page.blocks[hash] = {};
                                page.blocks[hash].path = filePath;
                                page.blocks[hash].text = parts[5];

                                page.blocks[hash].rect = {
                                    left: left + 10,
                                    top: Number(parts[2]) + 10,
                                    width: Number(parts[3]),
                                    height: Number(parts[4])
                                };

                                if (left >= 0) {
                                    page.added.push(hash);
                                }
                            }
                        }
                    }
                });

                if (counter > 0) {
                    flushAddedBlocks();
                    flushDeckItems();
                    loadSavedPage(page);
                }

                $main.removeClass('is-loading');

                showNotification('Добавлено звуков: <b>' + counter + '</b>. ' +
                    'Пропущено: <b>' + (lineNum - counter) + '</b>');
            }
        });
    });

    // ------------- //
    //  Body events  //
    // ------------- //

    $body.on('click', '.block-delete', function () {
        if (isEditMode()) {
            const hash = $(this).parent().data('for');
            const selector = '[data-hash="' + hash + '"]';
            $(selector)[0]._tippy.destroy();
            removeBlockFromPage(hash);
            _.pull(activePages[currentTab].added, hash);
            updateDeckData();
        }
    }).on('click', '.block-rename', function () {
        if (isEditMode()) {
            const hash = $(this).parent().data('for');
            const selector = '[data-hash="' + hash + '"]';
            $(selector).find('.sound-text').trigger('edit');
        }
    }).on('click', '.tab-rename', function () {
        if (isEditMode()) {
            const hash = $(this).parent().data('for');
            const selector = '.tab[data-page="' + hash + '"]';
            $(selector)[0]._tippy.hide();
            $(selector).find('.text').trigger('edit');
        }
    }).on('click', '.tab-delete', function () {
        if (isEditMode()) {
            const hash = $(this).parent().data('for');
            const selector = '[data-page="' + hash + '"]';
            const $prevTab = $('.tab' + selector).prev();
            $(selector)[0]._tippy.destroy();
            $(selector).remove();
            reorderTabs();

            delete activePages[hash];
            currentTab = '';

            if ($tabList.find('li').length === 0) {
                addNewEmptyPage();
            }

            if ($prevTab.length > 0) {
                $prevTab.click();
            } else {
                $tabList.find('li:first').click();
            }
        }
    }).on('click', '.tab-add', function () {
        if (isEditMode()) {
            const hash = $(this).parent().data('for');
            const selector = '.tab[data-page="' + hash + '"]';
            $(selector)[0]._tippy.hide();
            addNewEmptyPage($(selector));
        }
    }).on('keypress', '.sound-text textarea, .text textarea', function (e) {
        // Prevent new line on Enter key
        if (e.which === 13) {
            e.target.blur();
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
        if (_.size(activePages[currentTab].blocks) > 0) {
            const before = _.size(activePages[currentTab].blocks);
            stopCurrentSound();
            flushDeckItems();
            showNotification('Удалено из колоды: <b>' + (before - _.size(activePages[currentTab].blocks)) + '</b>');
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
