/* global window, document, navigator, $, SBar, fancy, requestAnimationFrame */

'use strict';

const {webFrame, remote, shell} = require('electron');
const {dialog} = require('electron').remote;
const path = require('path');
const fs = require('fs');
const farmhash = require('farmhash');
const filenamify = require('filenamify');
const hotkeys = require('hotkeys-js');
const iconvlite = require('iconv-lite');
const slugify = require('@sindresorhus/slugify');
const _ = require('lodash');
const fg = require('fast-glob');
const List = require('list.js');

const tippy = require('tippy.js/umd/index');
const hp = require('./vendor/howler');
const config = require('./config');

const keyboardArray = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];
const editClass = 'has-bottom';
const audioExtensions = ['mp3', 'mpeg', 'opus', 'ogg', 'oga', 'wav', 'aac', 'caf', 'm4a', 'mp4', 'weba', 'webm', 'dolby', 'flac'];
const howlDb = {};
const activePages = {};
const pageSearch = {};
const projectSearch = {};
const allPages = config.get('pages') || {};
const allProjects = config.get('projects') || {};

let currentTab = config.get('currentTab') || '';
let currentProject = config.get('currentProject') || '';
let deviceId = config.get('device') || 'default';
let $wrapper;
let $main;
let $tabList;

let notifyHandle;
let lastPlayedHash = '';
let lastAddedHash = '';
let $currentBlock;

window.$ = require('jquery');
window.jQuery = require('jquery');
window.jQueryUI = require('jquery-ui-dist/jquery-ui');
window.SBar = require('simplebar');
window.jEditable = require('jquery-jeditable');
window.fancy = require('fancy-textfill/dist/fancy-text-fill');

// ================== //
//                    //
//   Main Functions   //
//                    //
// ================== //

// Show notification
function showNotification(text, error, time) {
    clearTimeout(notifyHandle);
    const $notify = $('.notification');
    const timer = time ? time : 4000;

    $notify.removeClass('is-danger');
    if (error === true) {
        $notify.addClass('is-danger');
    }

    $notify.html(text).fadeIn();
    notifyHandle = setTimeout(function () {
        $notify.fadeOut();
    }, timer);
}

// Confirm action
function confirmAction(text) {
    return dialog.showMessageBox({
        buttons: ['Нет', 'Да'],
        message: text,
        cancelId: 3
    });
}

// Toggle edit mode
function toggleEditMode() {
    const $blocks = $('.sound-block');
    const $tabs = $('#tabs .tab');

    toggleSidebarClasses(editClass);
    config.set('editMode', isEditMode());

    if (isEditMode()) {
        $blocks.draggable('enable').resizable('enable');
        $('.deck-items .panel-block').draggable('enable');
        $('.main').selectable('enable');
        $('.page-remove').prop('disabled', false);
    } else {
        freezePageEditing($blocks, $tabs);
    }
}

// Initialize draggable/resizable block
function initDraggableMain($element) {
    const hash = $element.data('hash');
    let oldPos;

    $element.draggable({
        grid: [10, 10],
        containment: 'parent',
        stack: '.sound-block',
        scroll: false,
        start: function (e, ui) {
            oldPos = ui.position;
        },
        drag: function (e, ui) {
            if (e.target.classList.contains('ui-selected') && oldPos !== ui.position) {
                const topOffset = ui.position.top - oldPos.top;
                const leftOffset = ui.position.left - oldPos.left;

                $('.ui-selected').not(this).each(function () {
                    $(this).css({
                        top: this.offsetTop + topOffset,
                        left: this.offsetLeft + leftOffset
                    });
                });

                oldPos = ui.position;
            }
        },
        stop: function (e) {
            const hash = e.target.dataset.hash;
            activePages[currentTab].blocks[hash].rect = getRectWithOffset(e.target);

            if (e.target.classList.contains('ui-selected')) {
                $('.ui-selected').not(this).each(function () {
                    activePages[currentTab].blocks[this.dataset.hash].rect = getRectWithOffset(this);
                });
            }
        }
    }).resizable({
        grid: [10, 10],
        containment: 'parent',
        stop: function (e) {
            const hash = e.target.dataset.hash;
            activePages[currentTab].blocks[hash].rect = getRectWithOffset(e.target);
        },
        resize: _.debounce(function () {
            autoSizeText($element);
        }, 200)
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
                const fontSize = parseInt($text.css('font-size'), 10);
                settings.rows = _.round($text.height() / fontSize);
            },
            callback: function (value) {
                activePages[currentTab].blocks[hash].text = value;
                autoSizeText($element);
            }
        });
    }, 200);

    setTimeout(function () {
        autoSizeText($element);
    }, 500);
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
    const mainHeight = $main.height();
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

    const $dropped = $main.find(selector);

    if (position === false) {
        positioned = autoPosition($dropped[0]);
    } else {
        $dropped[0].style.left = roundToTen(position.left - offsetLeft - 10) + 'px';
        $dropped[0].style.top = roundToTen(position.top - offsetTop - 10) + 'px';
        positioned = true;
    }

    if (positioned) {
        activePages[currentTab].blocks[hash].rect = getRectWithOffset($dropped[0]);
        activePages[currentTab].added.push(hash);

        setTimeout(function () {
            initDraggableMain($dropped);
        }, 100);

        return true;
    }

    return false;
}

// Add a previously saved sound block to main div
function addSavedSoundBlock(hash, pageHash) {
    const selector = '[data-hash="' + hash + '"]';
    const text = activePages[pageHash].blocks[hash].text;
    const rect = activePages[pageHash].blocks[hash].rect;
    const $mainSelector = $('.main[data-page="' + pageHash + '"]');

    const html = '<a class="button is-dark sound-block"' +
        ' data-hash="' + hash + '"><div class="sound-overlay"></div>' +
        '<div class="sound-text">' + text + '</div></a>';

    $(html).appendTo($mainSelector).css({
        top: rect.top,
        left: rect.left,
        height: rect.height,
        width: rect.width
    });

    initDraggableMain($mainSelector.find(selector));
}

// Append HTML of the item to the deck
function appendDeckItemHtml(hash, text, pageHash) {
    const html = '<a class="panel-block"' +
        ' data-hash="' + hash + '"><div class="sound-overlay"></div>' +
        '<div class="sound-text">' + text + '</div></a>';
    const deckHash = pageHash ? pageHash : currentTab;
    const selector = $('.deck-items[data-page="' + deckHash + '"] .simplebar-content');

    $(html).prependTo(selector).draggable({
        appendTo: 'body',
        revert: 'invalid',
        scroll: false,
        helper: 'clone',
        delay: 200,
        distance: 10
    }).on('dblclick', function (e) {
        const $target = $(e.currentTarget);
        if (isEditMode()) {
            addSoundBlockFromDeck($target, false);
            updateDeckData();
            $target.off('dblclick');
        }
    });
}

// Init Howl object and add it to howlDB
function addInitHowl(hash, soundPath) {
    if (_.keys(howlDb).includes(hash)) {
        // 1 console.log('Howl already loaded: ' + hash);
    } else {
        howlDb[hash] = new hp.Howl({
            src: [soundPath],
            html5: true,
            sinkId: deviceId,
            preload: false,
            onplay: function () {
                requestAnimationFrame(updateAudioStep);
            }
        });
    }
}

// Add sound block to the deck
function addDeckItemFromFile(soundPath) {
    const hash = getFileHash(soundPath);
    const text = path.parse(soundPath).name;

    if (_.keys(activePages[currentTab].blocks).includes(hash)) {
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

    updateDeckData();
}

// Set deck counter value
function setDeckCounter() {
    const $deck = $('#deck');
    const $counter = $deck.find('.count');
    const $items = $deck.find('.deck-items[data-page="' + currentTab + '"] .panel-block');
    $counter.text($items.length);
}

// Update deck items
function updateDeckData() {
    recalcScrollbars();
    setDeckCounter();
    activePages[currentTab].list.reIndex();
}

// Delete one block from the page
function removeBlockFromPage(hash) {
    delete activePages[currentTab].blocks[hash].rect;
    $main.find('[data-hash="' + hash + '"]').remove();
    appendDeckItemHtml(hash, activePages[currentTab].blocks[hash].text);
}

// Save all pages/projects/settings to config
function saveAllData(skipNotify) {
    const activeTabs = getActiveTabs();

    activeTabs.forEach(function (hash) {
        allPages[hash] = _.omit(activePages[hash], ['bar', 'list']);
    });

    config.set('activeTabs', activeTabs);
    config.set('currentTab', currentTab);
    config.set('pages', allPages);
    config.set('projects', allProjects);
    config.set('currentProject', currentProject);

    if (!skipNotify) {
        showNotification('Данные сохранены в базу!', false, 2000);
    }
}

// Show a dialog for folder selection, return sounds
function showFolderSelectionDialog(callback, finish, title) {
    let files = [];

    dialog.showOpenDialog({
        title: title ? title : 'Выберите папки со звуками',
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

// Add page to database
function addPageToDatabase(page) {
    if (!savedPageExists(page.hash)) {
        addPageToList(page.hash, page.name, true);
        allPages[page.hash] = page;
    }
}

// Load saved page
function loadSavedPage(page, skipTab) {
    const pageHash = page.hash;
    activePages[pageHash] = page;

    if (!skipTab) {
        const tabHtml = $(getTabHtml(page.name, pageHash));
        $tabList.append(tabHtml);
    }

    addPageToDatabase(page);

    initNewPageBlocks(pageHash);

    updateMainHeight();

    if (_.size(page.blocks) > 0) {
        _.each(page.blocks, function (block, hash) {
            if (page.added.includes(hash)) {
                addSavedSoundBlock(hash, pageHash);
            } else {
                appendDeckItemHtml(hash, block.text, pageHash);
            }

            addInitHowl(hash, block.path);
        });

        if (pageHash === currentTab) {
            updateDeckData();
        }
    }

    saveAllData(true);
}

// Load PPv2 page
function loadPpv2(filePath) {
    const file = iconvlite.decode(fs.readFileSync(filePath), 'win1251');
    const parsed = path.parse(filePath);
    const pageName = path.basename(parsed.dir);
    const pageHash = getStringHash(pageName);

    if (pageExists(pageHash)) {
        return false;
    }

    const lines = file.split(/\r?\n/);
    let lineNum = 0;
    let counter = 0;

    const page = {
        hash: pageHash,
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

                if (!_.keys(page.blocks).includes(hash)) {
                    const left = Number(parts[1]) + 10;
                    const top = Number(parts[2]) + 10;
                    const width = Number(parts[3]);
                    const height = Number(parts[4]);

                    counter++;

                    page.blocks[hash] = {};
                    page.blocks[hash].path = filePath;
                    page.blocks[hash].text = parts[5];

                    if (left >= 10) {
                        page.blocks[hash].rect = {
                            left: left,
                            top: top,
                            bottom: top + height,
                            right: left + width,
                            width: width,
                            height: height
                        };

                        page.added.push(hash);
                    }
                }
            }
        }
    });

    if (counter > 0) {
        addPageToDatabase(page);
    }

    return {
        added: counter,
        skipped: lineNum - counter,
        name: pageName
    };
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

    addPageToList(hash, text, true);

    activePages[hash] = {
        hash: hash,
        name: text,
        added: [],
        blocks: {}
    };

    initNewPageBlocks(hash);

    updateMainHeight();

    saveAllData(true);
}

// Init everything for a new page
function initNewPageBlocks(hash) {
    const selector = '[data-page="' + hash + '"]';
    $('.wrapper').append('<div class="main" data-page="' + hash + '">');
    $('#deck-bottom').before('<div class="deck-items" data-page="' + hash + '"></div>');
    $('#search-wrapper').prepend('<input class="input search search-' + hash + '" ' +
        'type="text" data-page="' + hash + '" placeholder="фильтр">');
    $('#deck > .panel-search').after('<p class="panel-tabs" data-page="' + hash + '">' +
        '<a class="sort sort-' + hash + '" data-sort="sound-text">по алфавиту</a>' +
        '<a class="sort by-length desc sort-' + hash + '">по длине</a></p>');

    const $tabSelector = $('.tab' + selector);
    const $mainSelector = $('.main' + selector);
    const $deckSelector = $('.deck-items' + selector);

    activePages[hash].bar = new SBar($deckSelector[0]);
    $deckSelector.find('.simplebar-content').addClass('list-' + hash);
    activePages[hash].list = new List('deck', {
        valueNames: ['sound-text'],
        listClass: 'list-' + hash,
        searchClass: 'search-' + hash,
        sortClass: 'sort-' + hash
    });

    initEditableTab($tabSelector);
    $tabList.sortable('refresh');
    reorderTabs();

    $mainSelector.on('click', '.sound-block', function () {
        if (!isEditMode()) {
            playSound(this);
        }
    }).on('contextmenu', '.sound-block', function (e) {
        e.preventDefault();
        if (isEditMode() && e.ctrlKey) {
            $(e.currentTarget).find('.sound-text').trigger('edit');
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
        accept: '.deck .panel-block',
        drop: function (e, ui) {
            const offsetTop = getTopOffset();
            const offsetLeft = getLeftOffset();

            if (activePages[currentTab].list.searched) {
                activePages[currentTab].list.search();
                $('.search-' + currentTab).val('').focus();
            }

            addSoundBlockFromDeck(ui.draggable, ui.position, offsetTop, offsetLeft);
            updateDeckData();
        }
    }).selectable({
        filter: '.sound-block'
    });
}

// Add new page to the list
function addPageToList(hash, text, reindex) {
    const html = '<a class="panel-block page" data-page="' + hash + '">' +
        '<button class="button is-dark page-remove"><i class="fa fa-times"></i></button>' +
        '<span class="text">' + text + '</span>' +
        '</a>';
    $(html).appendTo('#page-search .simplebar-content').draggable({
        appendTo: 'body',
        revert: 'invalid',
        scroll: false,
        helper: 'clone',
        connectToSortable: '#tabs > ul',
        delay: 200,
        distance: 10
    }).dblclick(function (e) {
        const hash = e.currentTarget.dataset.page;
        if (activePageExists(hash)) {
            showNotification('Такой таб уже есть!', true, 1500);
        } else {
            actionWithLoading(function () {
                loadPageFromList(hash);
            });
        }
    });

    if (reindex) {
        updatePageSearch();
    }
}

// Add new page to the list
function addProjectToList(hash, text, reindex) {
    const html = '<a class="panel-block page" data-proj="' + hash + '">' +
        '<button class="button is-dark proj-remove"><i class="fa fa-times"></i></button>' +
        '<span class="text">' + text + '</span>' +
        '<button class="button is-dark proj-add"><i class="fa fa-chevron-right"></i></button>' +
        '</a>';

    $(html).appendTo('#project-search .simplebar-content').on('dblclick', function (e) {
        const hash = e.currentTarget.dataset.proj;
        const $this = $(e.currentTarget);

        if (hash !== currentProject) {
            actionWithLoading(function () {
                closeAllTabs();

                allProjects[hash].pages.forEach(function (page) {
                    loadSavedPage(allPages[page]);
                });

                tabClick(true);

                if (!isEditMode()) {
                    freezePageEditing();
                }
            });

            currentProject = hash;
            config.set('currentProject', currentProject);
            $('#project-search .is-active').removeClass('is-active');
            $this.addClass('is-active');
        }
    });

    if (reindex) {
        updateProjectSearch();
    }
}

// Action to perform when saving a project
function projectSaveAction(that) {
    const $modal = $(that).closest('.modal');
    const text = $modal.find('input').val().trim();
    if (text.length > 0) {
        const hash = getStringHash(text);

        if (!projectExists(hash)) {
            addProjectToList(hash, text, true);
        }

        allProjects[hash] = {
            name: text,
            pages: getActiveTabs()
        };
        config.set('projects', allProjects);
        currentProject = hash;
        config.set('currentProject', currentProject);

        $('#project-search .is-active').removeClass('is-active');
        $('[data-proj="' + hash + '"]').addClass('is-active');
        $modal.removeClass('is-active');

        showNotification('Сохранено как проект: <b>' + text + '</b>', false, 3000);
    }
}

// Close the tab
function closeTab(hash) {
    const selector = '[data-page="' + hash + '"]';
    const $tab = $('.tab' + selector);
    const $prevTab = $tab.prev();
    $(selector).not('.page').remove();
    reorderTabs();

    _.keys(activePages[hash].blocks).forEach(function (blockHash) {
        howlDb[blockHash].unload();
    });

    delete activePages[hash];
    currentTab = '';

    if ($prevTab.length > 0) {
        $prevTab.click();
    } else {
        tabClick(true);
    }
}

// Update zoom of the page
function updateZoom(delta) {
    let zoom = webFrame.getZoomFactor();
    if (delta < 0) {
        zoom += 0.01;
    } else {
        zoom -= 0.01;
    }

    zoom = _.round(zoom, 2);
    webFrame.setZoomFactor(zoom);
    showNotification('Текущий зум: ' + _.round(zoom * 100) + '%', false, 1500);
    config.set('zoom', zoom);
}

// Make tab text editable
function initEditableTab($tab) {
    $tab.find('.text').editable(function (value) {
        const val = value.replace(/\s+/g, ' ').trim();
        const hash = getStringHash(val);

        if (pageExists(hash)) {
            showNotification('Такая страница уже есть!', true, 1500);
            return activePages[$tab.attr('data-page')].name;
        }

        return val;
    }, {
        type: 'textarea',
        tooltip: null,
        rows: 1,
        event: 'edit',
        onblur: 'submit',
        onedit: function (settings, element) {
            settings.cols = element.textContent.length + 5;
        },
        callback: function (value) {
            if (activePages[$tab.attr('data-page')].name !== value) {
                const oldHash = $(this).closest('.tab').attr('data-page');
                const newHash = getStringHash(value);
                activePages[newHash] = activePages[oldHash];
                activePages[newHash].hash = newHash;
                activePages[newHash].name = value;

                delete allPages[oldHash];
                delete activePages[oldHash];
                config.delete('pages.' + oldHash);

                if (currentTab === oldHash) {
                    currentTab = newHash;
                    config.set('currentTab', currentTab);
                }

                $('.page[data-page="' + oldHash + '"] > .text').text(value);
                $('[data-page="' + oldHash + '"]').attr('data-page', newHash);

                saveAllData(true);
            }
        }
    });
}

// Update numbers in tabs
function reorderTabs() {
    $('#tabs .tab').each(function (index) {
        if (index < 10 || index > 19) {
            $(this).find('strong').text(index + 1);
        } else {
            $(this).find('strong').text(keyboardArray[index - 10].toUpperCase());
        }
    });
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
            delete activePages[currentTab].blocks[hash];
            $('.deck-items[data-page="' + currentTab + '"] .simplebar-content').empty();
        }
    });

    lastPlayedHash = '';
}

// Prevent dragging/resizing of the main blocks
function freezePageEditing(blocks) {
    const $blocks = blocks || $('.sound-block');

    $blocks.draggable('disable').resizable('disable');
    $('.deck-items .panel-block').draggable('disable');
    $('.ui-selected').removeClass('ui-selected');
    $('.main').selectable('disable');
    $('.page-remove').prop('disabled', true);
}

// Close all tabs
function closeAllTabs() {
    saveAllData(true);
    _.keys(activePages).forEach(function (hash) {
        closeTab(hash);
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

// Autosize text inside block
function autoSizeText($block) {
    const $text = $block.find('.sound-text');

    fancy.fillParentContainer($text[0], {
        maxFontSize: 400,
        maxWidth: $block.width() - 2,
        maxHeight: $block.height() - 2
    });
}

// Sets width of audio overlay
function setAudioOverlay(width) {
    $currentBlock.find('.sound-overlay').width(width);
}

// Update block audio animation
function updateAudioStep() {
    const sound = howlDb[lastPlayedHash];
    if (sound !== undefined && sound.state() !== 'unloaded') {
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
    activePages[currentTab].bar.recalculate();
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

// Remove blocks without path from json
function filterBlocksWithoutPath(json) {
    _.keys(json.blocks).forEach(function (hash) {
        const block = json.blocks[hash];
        if (!_.keys(block).includes('path')) {
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
    return $('#tabs').outerHeight();
}

// Get height of all the bottom blocks
function getLeftOffset() {
    return 250;
}

// Update height of the main block
function updateMainHeight() {
    setTimeout(function () {
        $('.main').css({
            height: 'calc(100% - ' + getTopOffset() + 'px)'
        });
    }, 500);
}

// Toggle sidebar classes
function toggleSidebarClasses(name) {
    $('body').toggleClass(name);
}

// Return HTML code for a tab
function getTabHtml(text, hash) {
    return '<li class="tab" data-page="' + hash + '">' +
        '<a class="link"><span class="icon fa-stack">' +
        '<i class="fa fa-circle fa-stack-2x"></i>' +
        '<strong class="fa-stack-1x">1</strong></span>' +
        '<span class="text">' + text + '</span>' +
        '<span class="icon tab-remove"><i class="fa fa-times"></i></span>' +
        '</a></li>';
}

// Get a random short string
function getRandomString(length) {
    return getStringHash(_.random(1000000).toString()).slice(0, length);
}

// Reset deck list
function resetDeckList() {
    activePages[currentTab].list.search();
    $('.search-' + currentTab).val('');
}

// Check if page with Hash already exists
function pageExists(hash) {
    return _.keys(allPages).includes(hash) || _.keys(activePages).includes(hash);
}

// Check if page has already been added to DB
function savedPageExists(hash) {
    return _.keys(allPages).includes(hash);
}

// Check if page with Hash has been already added
function activePageExists(hash) {
    return _.keys(activePages).includes(hash);
}

// Check if page with Hash already exists
function projectExists(hash) {
    return _.keys(allProjects).includes(hash);
}

// Reinit page search
function updatePageSearch() {
    pageSearch.list.reIndex();
    pageSearch.bar.recalculate();
}

// Reinit project search
function updateProjectSearch() {
    projectSearch.list.reIndex();
    projectSearch.bar.recalculate();
}

// Click on tab
function tabClick(hash) {
    let search;

    switch (hash) {
        case true:
            search = 'li:first';
            break;
        case false:
            search = 'li:last';
            break;
        default:
            search = '[data-page="' + hash + '"]';
    }

    $tabList.find(search).click();
}

// Load page from list in navigator
function loadPageFromList(hash, skipTab) {
    loadSavedPage(allPages[hash], skipTab);
    tabClick(hash);

    if (!isEditMode()) {
        freezePageEditing();
    }
}

// Perform an action, show loading before it
function actionWithLoading(callback) {
    $wrapper.addClass('is-loading');
    setTimeout(function () {
        callback();
        $wrapper.removeClass('is-loading');
    });
}

// Get active tabs as an ordered array
function getActiveTabs() {
    return $('#tabs .tab').map(function () {
        return this.dataset.page;
    }).get();
}

// Unselect all projects
function unselectProjects() {
    currentProject = '';
    config.set('currentProject', currentProject);
    $('#project-search .is-active').removeClass('is-active');
}

// ================== //
//                    //
//   Global actions   //
//                    //
// ================== //

// Do actions before window is closed or reloaded
window.addEventListener('beforeunload', function () {
    saveAllData(true);
});

// ================================= //
//                                   //
//   Main action on document.ready   //
//                                   //
// ================================= //

$(function () {
    const mainWindow = remote.getCurrentWindow();
    const $body = $('body');
    $tabList = $('#tabs > ul');
    $wrapper = $('.wrapper');

    const editMode = config.get('editMode') || false;
    if (editMode === true) {
        toggleSidebarClasses(editClass);
    }

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
        delay: 200,
        distance: 10,
        stop: function (event, ui) {
            if (ui.item.hasClass('panel-block')) {
                const hash = ui.item.attr('data-page');

                if (activePageExists(hash)) {
                    showNotification('Такой таб уже есть!', true, 1500);
                    ui.item.remove();
                } else {
                    const text = ui.item.text();
                    ui.item.replaceWith(getTabHtml(text, hash));
                    actionWithLoading(function () {
                        loadPageFromList(hash, true);
                    });
                }
            }

            reorderTabs();
        }
    }).on('click', '.tab', function (e) {
        // Tab change event
        if (activePages[currentTab] !== undefined) {
            resetDeckList();
        }

        $('.ui-selected').removeClass('ui-selected');
        currentTab = e.currentTarget.dataset.page;
        config.set('currentTab', currentTab);
        const selector = '[data-page="' + currentTab + '"]';
        $('[data-page]').not('.tab, .page').hide();
        $main = $('.main' + selector);
        updateDeckData();
        $(selector).show();
        $(e.delegateTarget).find('.is-active').removeClass('is-active');
        $(e.currentTarget).addClass('is-active');
    }).on('contextmenu', '.tab', function (e) {
        e.preventDefault();
        if (isEditMode()) {
            $(e.currentTarget).find('.text').trigger('edit');
        }
    }).on('click', '.tab-remove', function (e) {
        e.stopPropagation();
        const $this = $(this);
        const hash = $this.closest('.tab').attr('data-page');
        actionWithLoading(function () {
            updateMainHeight();
            saveAllData(true);
            closeTab(hash);
        });
    });

    // Show tooltip with buttons in Edit mode
    tippy($('#tab-actions')[0], {
        content: '<div class="block-controls">' +
            '<button class="button close-tabs" title="Закрыть все табы"><i class="fa fa-times-circle"></i></button>' +
            '<button class="button add-tab" title="Добавить таб"><i class="fa fa-plus-circle"></i></button>' +
            '<button class="button proj-save" title="Сохранить как текущий проект"><i class="fa fa-floppy-o"></i></button>' +
            '<button class="button proj-saveas" title="Сохранить как…"><i class="fa fa-file-text"></i></button>' +
            '</div>',
        arrow: true,
        aria: null,
        distance: 5,
        interactive: true,
        placement: 'bottom'
    });

    // Init page search
    pageSearch.bar = new SBar($('#page-search .items')[0]);
    pageSearch.list = new List('page-search', {
        valueNames: ['text'],
        listClass: 'simplebar-content'
    });

    // Init project search
    projectSearch.bar = new SBar($('#project-search .items')[0]);
    projectSearch.list = new List('project-search', {
        valueNames: ['text'],
        listClass: 'simplebar-content'
    });
    projectSearch.list.on('searchComplete', _.debounce(function () {
        $('#project-search .items .panel-block').each(function () {
            const hash = this.dataset.proj;
            if (currentProject !== hash) {
                $(this).removeClass('is-active');
            }
        });
    }, 200));

    // Load page names to navigator
    _.keys(allPages).forEach(function (hash) {
        addPageToList(hash, allPages[hash].name);
    });
    updatePageSearch();

    // Load project names to navigator
    _.keys(allProjects).forEach(function (hash) {
        addProjectToList(hash, allProjects[hash].name);
    });
    if (currentProject.length > 0) {
        $('[data-proj="' + currentProject + '"]').addClass('is-active');
    }

    updateProjectSearch();

    // Load pages info from config
    const tabs = config.get('activeTabs');
    if (tabs.length > 0) {
        tabs.forEach(function (hash) {
            loadSavedPage(allPages[hash]);
        });
    }

    // Set zoom if it's in the config
    const zoom = config.get('zoom');

    // Click current tab if it's saved in the config + zoom
    setTimeout(function () {
        if (currentTab.length > 0) {
            tabClick(currentTab);
        } else {
            tabClick(true);
        }

        if (zoom !== undefined) {
            webFrame.setZoomFactor(zoom);
        }
    }, 200);

    // Freeze editing if not in Edit mode
    if (!isEditMode()) {
        freezePageEditing();
    }

    // Add block from single or multiple files
    $('#add-sound').click(function () {
        if (_.size(activePages) > 0) {
            $wrapper.addClass('is-loading');

            dialog.showOpenDialog({
                title: 'Выберите звуки',
                properties: ['openFile', 'multiSelections'],
                filters: [{
                    name: 'Аудио',
                    extensions: audioExtensions
                }]
            }, function (files) {
                if (files === undefined) {
                    $wrapper.removeClass('is-loading');
                } else {
                    addFileBlocks(files);
                    $wrapper.removeClass('is-loading');
                }
            });
        } else {
            showNotification('Нет активной страницы', true, 1500);
        }
    });

    // Add folder with sounds
    $('#add-folder').click(function () {
        if (_.size(activePages) > 0) {
            $wrapper.addClass('is-loading');

            showFolderSelectionDialog(function (files) {
                addFileBlocks(files);
            }, function () {
                $wrapper.removeClass('is-loading');
            });
        } else {
            showNotification('Нет активной страницы', true, 1500);
        }
    });

    // Export current page to a file
    $('#page-export').click(function () {
        if (_.size(activePages) > 0) {
            const pageName = activePages[currentTab].name;
            const fileName = getPageName(pageName);

            $wrapper.addClass('is-loading');

            dialog.showSaveDialog({
                title: 'Сохранить страницу в файл',
                defaultPath: fileName,
                filters: [{
                    name: 'JSON',
                    extensions: ['json']
                }]
            }, function (filePath) {
                if (filePath === undefined) {
                    $wrapper.removeClass('is-loading');
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
                    $wrapper.removeClass('is-loading');
                    showNotification('Сохранено в <b>' + fileName + '</b>');
                }
            });
        } else {
            showNotification('Нет активной страницы', true, 1500);
        }
    });

    // Import a page from a file
    $('#page-import').click(function () {
        $wrapper.addClass('is-loading');

        dialog.showOpenDialog({
            title: 'Выберите сохраненную страницу',
            properties: ['openFile'],
            filters: [{
                name: 'JSON',
                extensions: ['json']
            }]
        }, function (files) {
            if (files === undefined) {
                $wrapper.removeClass('is-loading');
            } else {
                let json = JSON.parse(fs.readFileSync(files[0]));

                if (json.type && json.type === 'page' && files.length > 0) {
                    if (pageExists(json.hash)) {
                        $wrapper.removeClass('is-loading');
                        showNotification('Такая страница уже есть!', true, 1500);
                    } else {
                        let counter = 0;
                        const filesNum = _.size(json.blocks);

                        showFolderSelectionDialog(function (files) {
                            for (const file of files) {
                                const hash = getFileHash(file);
                                if (_.keys(json.blocks).includes(hash)) {
                                    json.blocks[hash].path = path.win32.normalize(file);
                                    counter++;
                                }
                            }

                            json = _.omit(filterBlocksWithoutPath(json), ['type']);

                            if (counter > 0) {
                                addPageToDatabase(json);
                            }
                        }, function () {
                            $wrapper.removeClass('is-loading');

                            showNotification('Добавлена страница <b>' + json.name + '</b>. &nbsp;Звуков: <b>' + counter + '</b>, пропущено: <b>' + (filesNum - counter) + '</b>');
                        }, 'Выберите папку со звуками для страницы "' + json.name + '"');
                    }
                } else {
                    $wrapper.removeClass('is-loading');
                    showNotification('Ошибка импортирования', true, 1500);
                }
            }
        });
    });

    // Remove all added blocks
    $('#remove-main').click(function () {
        if (_.size(activePages) > 0 && activePages[currentTab].added.length > 0) {
            const count = activePages[currentTab].added.length;
            stopCurrentSound();
            if (confirmAction('Удалить ВСЕ блоки со страницы в колоду?') === 1) {
                actionWithLoading(function () {
                    flushAddedBlocks();
                    updateDeckData();
                    showNotification('Удалено со страницы: <b>' + count + '</b>', 3000);
                });
            }
        } else {
            showNotification('Удалять нечего o_O', true, 1500);
        }
    });

    // Save all pages and projects to DB
    $('#save-all').click(function () {
        saveAllData();
    });

    // Show help
    $('#show-help').click(function () {
        $('#help').addClass('is-active');
    });

    // Import one PPv2 file
    $('#add-pp').click(function () {
        $wrapper.addClass('is-loading');

        dialog.showOpenDialog({
            title: 'Выберите файл prank.txt из PrankPlayer v2',
            properties: ['openFile'],
            filters: [{
                name: 'prank.txt (PPv2)',
                extensions: ['txt']
            }]
        }, function (files) {
            if (files === undefined) {
                $wrapper.removeClass('is-loading');
            } else {
                const result = loadPpv2(files[0]);
                if (result) {
                    saveAllData(true);
                    $wrapper.removeClass('is-loading');
                    showNotification('Добавлена страница <b>' + result.name + '</b>. &nbsp;Звуков: <b>' + result.added + '</b>, пропущено: <b>' + result.skipped + '</b>');
                } else {
                    $wrapper.removeClass('is-loading');
                    showNotification('Такая страница уже есть!', true, 1500);
                }
            }
        });
    });

    // Import multiple PPv2 files
    $('#add-ppx').click(function () {
        $wrapper.addClass('is-loading');

        dialog.showOpenDialog({
            title: 'Выберите папку со вложенными папками (напр. mp3)',
            properties: ['openDirectory']
        }, function (dirs) {
            if (dirs === undefined) {
                $wrapper.removeClass('is-loading');
            } else {
                const files = fg.sync('**/prank.txt', {
                    cwd: dirs[0],
                    caseSensitiveMatch: false,
                    onlyFiles: true,
                    absolute: true
                });

                if (files.length > 0) {
                    let addedCount = 0;
                    let skippedCount = 0;
                    let pageCount = 0;

                    files.forEach(function (file) {
                        const result = loadPpv2(file);
                        if (result) {
                            pageCount++;
                            addedCount += result.added;
                            skippedCount += result.skipped;
                        }
                    });

                    showNotification('Добавлено страниц: <b>' + pageCount + '</b>. &nbsp;Звуков: <b>' +
                        addedCount + '</b>, пропущено: <b>' + skippedCount + '</b>', false, 5000);

                    saveAllData(true);
                }

                $wrapper.removeClass('is-loading');
            }
        });
    });

    // ------------- //
    //  Body events  //
    // ------------- //

    $body.on('keydown', '.sound-text textarea, .text textarea', function (e) {
        // Prevent new line on Enter key
        if (e.which === 13) {
            e.target.blur();
        }
    }).on('click', '.modal-background, .modal .delete', function () {
        $('.modal.is-active').removeClass('is-active');
    }).keydown(function (e) {
        // Prevent tab key
        if (e.which === 9) {
            e.preventDefault();
        }
    }).on('keydown', '#deck .search', function (e) {
        // Escape erases search
        if (e.which === 27) {
            resetDeckList();
        }
    }).on('keydown', '#page-search .search', function (e) {
        if (e.which === 27) {
            pageSearch.list.search();
            e.currentTarget.value = '';
        }
    }).on('keydown', '#project-search .search', function (e) {
        if (e.which === 27) {
            projectSearch.list.search();
            e.currentTarget.value = '';
        }
    }).on('keydown', '#proj-create .input', function (e) {
        // Enter in project input
        if (e.which === 13) {
            projectSaveAction(e.target);
        }
    }).on('wheel', function (e) {
        if (e.ctrlKey) {
            const delta = e.originalEvent.deltaY;
            updateZoom(delta);
        }
    }).on('mouseenter', '.main', function () {
        document.activeElement.blur();
    }).on('click', '.close-tabs', function () {
        if (_.size(activePages) > 0) {
            actionWithLoading(function () {
                closeAllTabs();
                unselectProjects();
            });
        }
    }).on('click', '.add-tab', function () {
        if (isEditMode()) {
            addNewEmptyPage();
            tabClick(false);
        }
    }).on('click', '.proj-saveas', function () {
        if (isEditMode() && _.size(activePages) > 0) {
            const $modal = $('#proj-create');
            $modal.addClass('is-active').find('input').val('').focus();
        }
    }).on('click', '.btn-saveas', function () {
        projectSaveAction(this);
    }).on('click', '.close-proj', function () {
        unselectProjects();
    }).on('click', '.proj-save', function () {
        if (isEditMode() && _.size(activePages) > 0 && currentProject.length > 0) {
            const name = allProjects[currentProject].name;
            allProjects[currentProject].pages = getActiveTabs();
            config.set('projects', allProjects);
            showNotification('Сохранено как проект: <b>' + name + '</b>', false, 3000);
        }
    });

    // ----------- //
    //  Navigator  //
    // ----------- //

    $('#page-search').on('click', '.page-remove', function () {
        const $parent = $(this).parent();
        const hash = $parent.attr('data-page');

        if (confirmAction('Удалить страницу ' + allPages[hash].name.toUpperCase() + ' из базы?') === 1) {
            actionWithLoading(function () {
                if (_.keys(activePages).includes(hash)) {
                    saveAllData(true);
                    closeTab(hash);
                }

                $parent.remove();
                updatePageSearch();

                delete allPages[hash];
                config.delete('pages.' + hash);
            });
        }
    });

    // -------------- //
    //  Deck sidebar  //
    // -------------- //

    $('#deck').on('contextmenu', '.deck-items .panel-block', function () {
        playSound(this);
    }).on('click', '#batch-btn', function () {
        if (isEditMode() && _.size(activePages) > 0) {
            // Batch add several blocks from the top
            resetDeckList();
            const num = $('#batch-num').val();
            const $items = $('.deck-items[data-page="' + currentTab + '"] .panel-block');
            let count = 0;

            if (num > 0 && $items.length > 0) {
                actionWithLoading(function () {
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

                    showNotification('Добавлено блоков: <b>' + count + '</b>', 3000);

                    lastAddedHash = '';
                    updateDeckData();
                });
            } else {
                showNotification('Нет числа или список пуст', true, 2000);
            }
        }
    }).on('click', '.sort', function () {
        // Sort deck items
        if (activePages[currentTab].list !== undefined) {
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

                activePages[currentTab].list.sort(value, {
                    order: order,
                    sortFunction: sortByLength
                });

                $this.addClass(order);
            }
        }
    }).on('dragover', false).on('drop', function (e) {
        // Drag and drop files/folders
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

    // Unload and remove sounds from the deck
    $('#remove-deck').click(function () {
        if (isEditMode() && _.size(activePages) > 0 && _.size(activePages[currentTab].blocks) > 0) {
            const before = _.size(activePages[currentTab].blocks);
            stopCurrentSound();
            if (confirmAction('Удалить ВСЕ блоки из колоды?') === 1) {
                actionWithLoading(function () {
                    flushDeckItems();
                    showNotification('Удалено из колоды: <b>' +
                        (before - _.size(activePages[currentTab].blocks)) + '</b>', false, 3000);
                    updateDeckData();
                });
            }
        }
    });

    // --------------- //
    //  Set device ID  //
    // --------------- //

    $('#devices').on('click', '.list-item', function () {
        const id = this.dataset.id;
        const classList = this.classList;
        if (!classList.contains('is-active')) {
            deviceId = id;
            config.set('device', id);
            hp.Howler.setDevice(id);
            $(this).parent().find('.is-active').removeClass('is-active');
            classList.add('is-active');
            showNotification('Устройство установлено!', 1500);
        }
    });

    $('#set-device').click(function () {
        const $devices = $('#devices');
        const $list = $devices.find('.list');

        $list.empty();

        navigator.mediaDevices.enumerateDevices().then(function (devices) {
            const audioDevices = devices.filter(function (device) {
                return device.kind === 'audiooutput';
            });

            audioDevices.forEach(function (audioDevice) {
                const id = audioDevice.deviceId;
                const classes = id === deviceId ? 'list-item is-active' : 'list-item';
                const html = '<a class="' + classes + '" data-id="' + id + '">' +
                    audioDevice.label + '</a>';
                $list.append(html);
            });

            $devices.addClass('is-active');
        });
    });

    // --------- //
    //  HotKeys  //
    // --------- //

    // Toggle edit mode
    addHotkey('space', function () {
        toggleEditMode();
    });

    // Save all data
    addHotkey('ctrl+s', function () {
        saveAllData();
    });

    // Close current wab
    addHotkey('ctrl+w', function () {
        if (_.size(activePages) > 0) {
            actionWithLoading(function () {
                saveAllData(true);
                closeTab(currentTab);
            });
        }
    });

    // Quick switch keys 1-10
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 0].forEach(function (val, i) {
        addHotkey(val.toString(), function () {
            $tabList.find('li').eq(i).click();
        });
    });

    // Quick switch keys 11-20
    keyboardArray.forEach(function (val, i) {
        addHotkey(val, function () {
            $tabList.find('li').eq(i + 10).click();
        });
    });

    // Global scope
    hotkeys('*', function (e) {
        if (e.code.includes('Numpad')) {
            e.preventDefault();
            const num = e.code.slice(-1);
            $tabList.find('li').eq(num - 1).click();
        }

        if (e.key === '-') {
            updateZoom(1);
        }

        if (e.key === '=' || e.key === '+') {
            updateZoom(-1);
        }
    });

    // Remove selected blocks
    addHotkey('delete', function () {
        if (isEditMode()) {
            actionWithLoading(function () {
                $('.ui-selected').each(function () {
                    const hash = this.dataset.hash;
                    removeBlockFromPage(hash);
                    _.pull(activePages[currentTab].added, hash);
                    updateDeckData();
                });
            });
        }
    });
});
