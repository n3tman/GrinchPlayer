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
const Store = require('electron-store');
const Shepherd = require('shepherd.js');
const tippy = require('tippy.js/umd/index');
const Fuse = require('fuse.js');
const moment = require('moment');

const hp = require('./vendor/howler');
const config = require('./config');

const keyboardArray = ['q', 'w', 'e', 'r', 't', 'a', 's', 'd', 'f', 'g', 'z', 'x', 'c', 'v', 'b'];
const russianArray = ['й', 'ц', 'у', 'к', 'е', 'ф', 'ы', 'в', 'а', 'п', 'я', 'ч', 'с', 'м', 'и'];
const editClass = 'has-bottom';
const audioExtensions = ['mp3', 'mpeg', 'opus', 'ogg', 'oga', 'wav', 'aac', 'caf', 'm4a', 'mp4', 'weba', 'webm', 'dolby', 'flac'];
const howlDb = {};
const pageSearch = {};
const projectSearch = {};
const blockBuffer = {type: '', blocks: {}};
const tutorial = config.get('tutorial') || false;

let allPages = config.get('pages') || {};
let allProjects = config.get('projects') || {};
let isEditMode = false;
let activePages = {};
let currentTab = config.get('currentTab') || '';
let currentProject = config.get('currentProject') || '';
let deviceId = config.get('device') || 'default';
let volume = config.get('volume') || 1;
let $wrapper;
let $main;
let $deckItems;
let $tabList;
let notifyHandle;
let lastPlayedHash = '';
let lastAddedHash = '';
let $currentBlock;
let selectedColor;
let tour;
let $quickSearch;
let fuseSearch;
let infoTipsActive = false;

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
function confirmAction(text, buttons) {
    return dialog.showMessageBox({
        buttons: buttons ? buttons : ['Нет', 'Да'],
        message: text,
        cancelId: 10
    });
}

// Toggle edit mode
function toggleEditMode() {
    const $blocks = $('.sound-block');
    isEditMode = !isEditMode;
    toggleBodyClass(editClass);

    actionWithLoading(function () {
        if (isEditMode) {
            _.keys(activePages).forEach(function (hash) {
                if (!activePages[hash].init) {
                    initEditablePage(hash);
                    initDraggableMain(hash);
                    initDeckEditable(hash);
                    activePages[hash].init = true;
                }
            });

            $blocks.draggable('enable').resizable('enable');
            $('.deck-items .panel-block').draggable('enable');
            $('.main, .deck-items').selectable('enable');
            $('.page-remove, .proj-remove, #batch-btn, #remove-deck').prop('disabled', false);
        } else {
            resetPageSearch();
            if (activePages[currentTab] !== undefined) {
                resetDeckList();
            }

            $blocks.draggable('disable').resizable('disable');
            $('.deck-items .panel-block').draggable('disable');
            $('.main, .deck-items').selectable('disable');
            $('.page-remove, .proj-remove, #batch-btn, #remove-deck').prop('disabled', true);
            $('#color-brush').removeClass('selected');
            $('body').removeClass('brush');

            unselectBlocks();
            saveAllData(true);
        }

        advanceIfTourStep('edit-mode');
    });
}

// Initialize draggable/resizable block
function initDraggableMain(main, single) {
    let $elements;
    if (single === true) {
        $elements = main;
    } else {
        $elements = $('.main[data-page="' + main + '"] .sound-block');
    }

    let oldPos;

    $elements.draggable({
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

                $main.find('.ui-selected').not(this).each(function () {
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
            allPages[currentTab].blocks[hash].rect = getRectWithOffset(e.target);

            if (e.target.classList.contains('ui-selected')) {
                $main.find('.ui-selected').not(this).each(function () {
                    allPages[currentTab].blocks[this.dataset.hash].rect = getRectWithOffset(this);
                });
            }
        }
    }).resizable({
        grid: [10, 10],
        containment: 'parent',
        stop: function (e) {
            const hash = e.target.dataset.hash;
            allPages[currentTab].blocks[hash].rect = getRectWithOffset(e.target);
        },
        resize: _.debounce(function (e, ui) {
            autoSizeText(ui.element);
        }, 100)
    }).mousedown(function (e) {
        if (e.which === 3 && isEditMode) {
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
        if (isEditMode) {
            playSound(e.currentTarget);
        }
    });

    // Make text editable in place on button click
    setTimeout(function () {
        $elements.find('.sound-text').editable(function (value) {
            return value.replace(/\s+/g, ' ').trim();
        }, {
            type: 'textarea',
            tooltip: null,
            event: 'edit',
            onblur: 'submit',
            width: '100%',
            onedit: function (settings, element) {
                const fontSize = parseInt(element.style.fontSize, 10);
                settings.rows = _.round(element.offsetHeight / fontSize);
            },
            callback: function (value) {
                allPages[currentTab].blocks[this.parentElement.dataset.hash].text = value;
                autoSizeText($(this.parentElement));
            }
        });
    }, 200); // 200 - because timeout is 100 on droppable

    setTimeout(function () {
        autoSizeText($elements);
    }, 300);
}

// Check block for collision with others
function isCollision(target, offsetTop, offsetLeft) {
    if (allPages[currentTab].added.length > 0) {
        const targetRect = target.getBoundingClientRect();
        const targetHash = target.dataset.hash;

        let collision = false;
        for (const hash of allPages[currentTab].added) {
            const block = allPages[currentTab].blocks[hash];

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
        const lastRect = allPages[currentTab].blocks[lastAddedHash].rect;
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
    const hash = $element.attr('data-hash');
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
        allPages[currentTab].blocks[hash].rect = getRectWithOffset($dropped[0]);
        allPages[currentTab].added.push(hash);

        // Timeout is needed because of jQuery UI
        setTimeout(function () {
            initDraggableMain($dropped, true);
        }, 100);

        return true;
    }

    return false;
}

// Add a previously saved sound block to main div
function addSavedSoundBlock(hash, pageHash, blockSource) {
    const source = blockSource ? blockSource : allPages[pageHash];
    const text = source.blocks[hash].text;
    const rect = source.blocks[hash].rect;
    const color = source.blocks[hash].color;
    const $mainSelector = $('.main[data-page="' + pageHash + '"]');

    const html = '<a class="button is-dark sound-block' +
        (blockSource ? ' ui-selected' : '') +
        (color ? ' bg-' + color : '') +
        '" data-hash="' + hash + '"><div class="sound-overlay"></div>' +
        '<div class="sound-text">' + text + '</div></a>';

    $(html).appendTo($mainSelector).css({
        top: rect.top,
        left: rect.left,
        height: rect.height,
        width: rect.width
    });
}

// Append HTML of the item to the deck
function appendDeckItemHtml(hash, text, pageHash) {
    const html = '<a class="panel-block"' +
        ' data-hash="' + hash + '"><div class="sound-overlay"></div>' +
        '<div class="sound-text">' + text + '</div></a>';
    const deckHash = pageHash ? pageHash : currentTab;
    const selector = $('.deck-items[data-page="' + deckHash + '"] .simplebar-content');

    $(html).prependTo(selector);
}

// Init editable elements in deck
function initDeckEditable(deck, single) {
    let $elements;
    if (single === true) {
        $elements = deck;
    } else {
        $elements = $('.deck-items[data-page="' + deck + '"] .panel-block');
    }

    $elements.draggable({
        appendTo: 'body',
        revert: 'invalid',
        scroll: false,
        helper: 'clone',
        delay: 200,
        distance: 10
    }).on('dblclick', function (e) {
        const $target = $(e.currentTarget);
        if (isEditMode) {
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
            },
            onloaderror: function () {
                $('[data-hash="' + hash + '"]').addClass('is-error');
            },
            onplayerror: function () {
                $('[data-hash="' + hash + '"]').addClass('is-error');
            }
        });
    }
}

// Add sound block to the deck
function addDeckItemFromFile(soundPath) {
    const hash = getFileHash(soundPath);
    const text = path.parse(soundPath).name;

    if (activeBlockExists(hash)) {
        console.log(text + ' === ' + allPages[currentTab].blocks[hash].text + '\n----------\n');
    } else {
        const selector = '[data-hash="' + hash + '"]';

        allPages[currentTab].blocks[hash] = {
            hash: hash,
            text: text,
            path: path.normalize(soundPath)
        };

        initBlockStats(currentTab, hash);
        addInitHowl(hash, soundPath);
        appendDeckItemHtml(hash, text);
        initDeckEditable($deckItems.find(selector), true);
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
    const before = _.size(allPages[currentTab].blocks);

    files.forEach(function (file) {
        addDeckItemFromFile(file);
    });

    const added = _.size(allPages[currentTab].blocks) - before;
    const skipped = files.length - added;

    showNotification('Добавлено звуков: <b>' + added + '</b>. ' +
        'Пропущено: <b>' + skipped + '</b>');

    updateDeckData();
}

// Set deck counter value
function setDeckCounter() {
    const $deck = $('#deck');
    const $counter = $deck.find('.count');
    const $items = $deckItems.find('.panel-block');
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
    const selector = '[data-hash="' + hash + '"]';
    const $element = $main.find(selector);
    const isError = $element.hasClass('is-error');
    delete allPages[currentTab].blocks[hash].rect;
    delete allPages[currentTab].blocks[hash].color;
    $element.remove();
    appendDeckItemHtml(hash, allPages[currentTab].blocks[hash].text);

    const $item = $deckItems.find(selector);
    initDeckEditable($item, true);

    if (isError) {
        $item.addClass('is-error');
    }
}

// Save all pages/projects/settings to config
function saveAllData(skipNotify) {
    const activeTabs = getActiveTabs();

    // Prevent saving pages with audio progress
    stopCurrentSound();

    activeTabs.forEach(function (hash) {
        const selector = '[data-page="' + hash + '"]';
        const mainHtml = document.querySelector('.main' + selector).outerHTML
            // Filter jQuery UI classes
            .replace(/ui[-\w]+\s*/g, '')
            // Filter is-searched and is-found classes for quick search
            .replace(/is-\w+\s*/g, '')
            // Filter random empty block
            .replace(/<div class="".+?<\/div>/g, '');

        if (_.size(activePages) > 0) {
            activePages[hash].store.set({
                name: allPages[hash].name,
                main: mainHtml
            });
        }
    });

    config.set('volume', volume);
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
        title: title ? title : 'Выбери папки со звуками',
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

// Init parameters for collecting page stats
function initPageStats(hash) {
    if (allPages[hash].addedDate === undefined) {
        allPages[hash].addedDate = new Date().toISOString();
    }

    if (allPages[hash].counter === undefined) {
        allPages[hash].counter = 0;
    }
}

// Init parameters for collecting block stats
function initBlockStats(page, hash) {
    if (allPages[page].blocks[hash].addedDate === undefined) {
        allPages[page].blocks[hash].addedDate = new Date().toISOString();
    }

    if (allPages[page].blocks[hash].counter === undefined) {
        allPages[page].blocks[hash].counter = 0;
    }
}

// Add page to database
function addPageToDatabase(page) {
    if (!savedPageExists(page.hash)) {
        addPageToList(page.hash, page.name, true);
        allPages[page.hash] = page;
        initPageStats(page.hash);
    }
}

// Load saved page
function loadSavedPage(page, skipTab) {
    const pageHash = page.hash;

    activePages[pageHash] = {
        init: false,
        store: new Store({
            cwd: 'pages',
            name: pageHash
        })
    };

    initPageStats(pageHash);
    allPages[pageHash].lastDate = new Date().toISOString();

    const isSaved = activePages[pageHash].store.has('main');

    if (!skipTab) {
        const tabHtml = $(getTabHtml(page.name, pageHash));
        $tabList.append(tabHtml);
    }

    initNewPageBlocks(pageHash, isSaved);

    if (_.size(page.blocks) > 0) {
        _.each(page.blocks, function (block, hash) {
            if (!page.added.includes(hash)) {
                appendDeckItemHtml(hash, block.text, pageHash);
            } else if (!isSaved) {
                addSavedSoundBlock(hash, pageHash);
            }

            initBlockStats(pageHash, hash);
            addInitHowl(hash, block.path);
        });

        activePages[pageHash].list.reIndex();
    }

    if (isEditMode) {
        initEditablePage(pageHash);
        initDraggableMain(pageHash);
        initDeckEditable(pageHash);
        activePages[pageHash].init = true;
    }
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
            const filePath = path.join(parsed.dir, parts[0]);
            lineNum++;

            if (fs.existsSync(filePath) && parts[0].length > 0 && parts[5].length > 0) {
                const hash = getFileHash(filePath);

                if (!_.keys(page.blocks).includes(hash)) {
                    const left = Number(parts[1]) + 10;
                    const top = Number(parts[2]) + 10;
                    const width = Number(parts[3]);
                    const height = Number(parts[4]);

                    counter++;

                    page.blocks[hash] = {
                        path: path.normalize(filePath),
                        text: parts[5],
                        addedDate: new Date().toISOString(),
                        counter: 0
                    };

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
function addNewEmptyPage() {
    const text = 'Таб#' + getRandomString(5);
    const hash = getStringHash(text);
    const tabHtml = $(getTabHtml(text, hash));

    $tabList.append(tabHtml);
    addPageToList(hash, text, true);

    allPages[hash] = {
        hash: hash,
        name: text,
        added: [],
        blocks: {}
    };

    activePages[hash] = {
        init: true,
        store: new Store({
            cwd: 'pages',
            name: hash
        })
    };

    initPageStats(hash);
    initNewPageBlocks(hash);
    initEditablePage(hash);
}

// Init everything for a new page
function initNewPageBlocks(hash, isSaved) {
    const selector = '[data-page="' + hash + '"]';

    let mainHtml = '<div class="main" data-page="' + hash + '">';
    if (isSaved === true) {
        mainHtml = activePages[hash].store.get('main');
    }

    document.querySelector('.wrapper').insertAdjacentHTML('beforeend', mainHtml);

    document.querySelector('#deck-bottom').insertAdjacentHTML('beforebegin',
        '<div class="deck-items" data-page="' + hash + '"></div>'
    );

    document.querySelector('#search-wrapper').insertAdjacentHTML('beforeend',
        '<input class="input search search-' + hash + '" type="text" data-page="' + hash + '" placeholder="фильтр">'
    );

    document.querySelector('#deck > .panel-search').insertAdjacentHTML('afterend',
        '<p class="panel-tabs" data-page="' + hash + '"><a class="sort sort-' + hash +
        '" data-sort="sound-text">по алфавиту</a><a class="sort by-length desc sort-' + hash + '">по длине</a></p>'
    );

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

    $tabList.sortable('refresh');
    reorderTabs();
    updateMainHeight();

    $mainSelector.on('click', '.sound-block', function () {
        if (!isEditMode) {
            const hash = this.dataset.hash;
            playSound(this);
            allPages[currentTab].blocks[hash].lastDate = new Date().toISOString();
            allPages[currentTab].blocks[hash].counter += 1;
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
    });
}

// Init editable elements of the page
function initEditablePage(hash) {
    const selector = '[data-page="' + hash + '"]';

    const $tabSelector = $('.tab' + selector);
    const $mainSelector = $('.main' + selector);
    const $deckSelector = $('.deck-items' + selector);

    initEditableTab($tabSelector);

    $mainSelector.on('contextmenu', '.sound-block', function (e) {
        e.preventDefault();
        if (isEditMode && e.ctrlKey) {
            $(e.currentTarget).find('.sound-text').trigger('edit');
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
        filter: '.sound-block',
        start: function () {
            unselectBlocks();
        }
    });

    $deckSelector.selectable({
        filter: '.panel-block',
        start: function () {
            unselectBlocks();
        }
    });
}

// Add new page to the list
function addPageToList(hash, text, reindex) {
    const html = '<a class="panel-block page" data-page="' + hash + '">' +
        '<button class="button is-dark page-remove"' +
        (isEditMode ? '' : ' disabled') +
        ' title="Удалить страницу"><i class="fa fa-times"></i></button>' +
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
            showNotification('Такая вкладка уже есть!', true, 1500);
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

// Load project tabs by hash
function loadProjectTabs(hash) {
    allProjects[hash].pages.forEach(function (page) {
        if (!activePageExists(page)) {
            loadSavedPage(allPages[page]);
        }
    });
}

// Add new project to the list
function addProjectToList(hash, text, reindex) {
    const html = '<a class="panel-block page" data-proj="' + hash + '">' +
        '<button class="button is-dark proj-remove"' +
        (isEditMode ? '' : ' disabled') +
        ' title="Удалить проект"><i class="fa fa-times"></i></button>' +
        '<span class="text">' + text + '</span>' +
        '<button class="button is-dark proj-add" title="Добавить страницы проекта к текущим"><i class="fa fa-chevron-right"></i></button>' +
        '</a>';

    $(html).appendTo('#project-search .simplebar-content').on('dblclick', function (e) {
        const hash = e.currentTarget.dataset.proj;
        const $this = $(e.currentTarget);

        actionWithLoading(function () {
            closeAllTabs();
            loadProjectTabs(hash);
            tabClick(true);
        });

        currentProject = hash;
        $('#project-search .is-active').removeClass('is-active');
        $this.addClass('is-active');
    }).on('contextmenu', function (e) {
        e.preventDefault();
        if (isEditMode) {
            $(e.currentTarget).find('.text').trigger('edit');
        }
    });

    initEditableProject($('[data-proj="' + hash + '"]'));

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
        currentProject = hash;

        $('#project-search .is-active').removeClass('is-active');
        $('[data-proj="' + hash + '"]').addClass('is-active');
        $modal.removeClass('is-active');

        showNotification('Сохранено как проект: <b>' + text + '</b>', false, 3000);
    }
}

// Project save as action
function projectSaveAs() {
    if (isEditMode && _.size(activePages) > 0) {
        const $modal = $('#proj-create');
        $modal.addClass('is-active').find('input').val('').focus().keydown(function (e) {
            if (e.which === 27) {
                $modal.removeClass('is-active');
            }
        });
    } else {
        showNotification('Нет активных страниц', true, 3000);
    }
}

// Project save button action
function projectSaveButton() {
    if (isEditMode && _.size(activePages) > 0 && currentProject.length > 0) {
        const name = allProjects[currentProject].name;
        allProjects[currentProject].pages = getActiveTabs();
        showNotification('Сохранено как проект: <b>' + name + '</b>', false, 3000);
    } else {
        showNotification('Нет активных страниц или проектов', true, 3000);
    }
}

// Close the tab
function closeTab(hash) {
    const selector = '[data-page="' + hash + '"]';
    const $prevTab = $('.tab' + selector).prev();

    resetPageSearch();
    document.querySelectorAll(selector).forEach(function (el, i) {
        if (i > 0) {
            el.remove();
        }
    });

    _.keys(allPages[hash].blocks).forEach(function (blockHash) {
        howlDb[blockHash].unload();
    });

    delete activePages[hash];
    currentTab = '';

    reorderTabs();

    if ($prevTab.length > 0) {
        $prevTab.click();
    } else {
        tabClick(true);
    }
}

// Close all tabs
function closeAllTabs() {
    const selector = '.tab, .main, .panel-tabs, .deck-items, .deck .search';
    document.querySelectorAll(selector).forEach(function (el) {
        el.remove();
    });
    hp.Howler.unload();
    activePages = {};
    currentTab = '';
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
    showNotification('Масштаб: ' + _.round(zoom * 100) + '%', false, 1500);
    config.set('zoom', zoom);
}

// Make tab text editable
function initEditableTab($tab) {
    $tab.find('.text').editable(function (value) {
        const val = value.replace(/\s+/g, ' ').trim();
        const hash = getStringHash(val);

        if (pageExists(hash)) {
            showNotification('Такая страница уже есть!', true, 1500);
            return allPages[$tab.attr('data-page')].name;
        }

        return val;
    }, {
        type: 'textarea',
        tooltip: null,
        rows: 1,
        event: 'edit',
        onblur: 'submit',
        onedit: function (settings, element) {
            settings.cols = element.textContent.length + 3;
        },
        callback: function (value) {
            if (allPages[$tab.attr('data-page')].name !== value) {
                const oldHash = $(this).closest('.tab').attr('data-page');
                const newHash = getStringHash(value);
                allPages[newHash] = allPages[oldHash];
                allPages[newHash].hash = newHash;
                allPages[newHash].name = value;
                activePages[newHash] = activePages[oldHash];

                delete allPages[oldHash];
                delete activePages[oldHash];

                if (currentTab === oldHash) {
                    currentTab = newHash;
                }

                resetPageSearch();
                $('.page[data-page="' + oldHash + '"] > .text').text(value);
                updatePageSearch();
                $('[data-page="' + oldHash + '"]').attr('data-page', newHash);

                // Fix having old hashes in cached html
                saveAllData(true);

                // Update hash in projects
                _.keys(allProjects).forEach(function (proj) {
                    const index = allProjects[proj].pages.indexOf(oldHash);
                    if (index > -1) {
                        allProjects[proj].pages[index] = newHash;
                    }
                });

                advanceIfTourStep('rename-page');
            }
        }
    });
}

// Make project item text editable
function initEditableProject($item) {
    const $text = $item.find('.text');

    $text.editable(function (value) {
        const val = value.replace(/\s+/g, ' ').trim();
        const hash = getStringHash(val);

        if (projectExists(hash)) {
            showNotification('Такой проект уже есть!', true, 1500);
            return allProjects[$item.attr('data-proj')].name;
        }

        return val;
    }, {
        type: 'textarea',
        tooltip: null,
        event: 'edit',
        onblur: 'submit',
        onedit: function (settings) {
            settings.rows = _.round($text.height() / 24);
        },
        callback: function (value) {
            if (allProjects[$item.attr('data-proj')].name !== value) {
                const oldHash = $item.attr('data-proj');
                const newHash = getStringHash(value);

                allProjects[newHash] = allProjects[oldHash];
                allProjects[newHash].name = value;

                delete allProjects[oldHash];

                if (currentProject === oldHash) {
                    currentProject = newHash;
                }

                resetProjectSearch();
                $text.text(value);
                $item.attr('data-proj', newHash);
                updateProjectSearch();
            }
        }
    });
}

// Update numbers in tabs
function reorderTabs() {
    $('#tabs .tab').each(function (index) {
        if (index < 5 || index > 19) {
            $(this).find('strong').text(index + 1);
        } else {
            $(this).find('strong').text(russianArray[index - 5].toUpperCase());
        }
    });
}

// Clear added blocks from main area
function flushAddedBlocks() {
    allPages[currentTab].added.forEach(function (hash) {
        removeBlockFromPage(hash);
    });

    lastPlayedHash = '';
    allPages[currentTab].added = [];
}

// Remove all deck items
function flushDeckItems(withFiles) {
    _.keys(allPages[currentTab].blocks).forEach(function (hash) {
        if (!allPages[currentTab].added.includes(hash)) {
            const filePath = allPages[currentTab].blocks[hash].path;
            howlDb[hash].unload();

            if (withFiles && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }

            delete allPages[currentTab].blocks[hash];
        }
    });

    $deckItems.find('.simplebar-content').empty();

    lastPlayedHash = '';
}

// Process selected blocks
function selectedBlocksAction(message, callback) {
    const $selected = $('.ui-selected');

    if (isEditMode && $selected.length > 0) {
        let $parent;
        let counter = 0;

        blockBuffer.blocks = {};

        if ($selected.first().parent().hasClass('main')) {
            blockBuffer.type = 'main';
            $parent = $main;
        } else {
            blockBuffer.type = 'deck';
            $parent = $deckItems;
            resetDeckList();
        }

        $parent.find('.ui-selected').each(function () {
            const hash = this.dataset.hash;
            const $this = $(this);
            blockBuffer.blocks[hash] = _.cloneDeep(allPages[currentTab].blocks[hash]);

            if (callback !== undefined) {
                callback($this, hash);
            }

            counter++;
        });

        unselectBlocks();

        if (blockBuffer.type === 'deck' && callback !== undefined) {
            updateDeckData();
        }

        showNotification(message + ': <b>' + counter + '</b>', false, 2000);
    }
}

// Add color to single block
function applySingleBlockColor(hash, $this) {
    const color = allPages[currentTab].blocks[hash].color;
    if (color !== undefined) {
        $this.removeClass('bg-' + color);
    }

    allPages[currentTab].blocks[hash].color = selectedColor;
    $this.addClass('bg-' + selectedColor);
}

// Apply color to selected blocks
function applySelectedBlockColor() {
    const $selected = $main.find('.ui-selected');

    if (selectedColor !== undefined && $selected.length > 0) {
        $selected.each(function () {
            const $this = $(this);
            const hash = this.dataset.hash;

            applySingleBlockColor(hash, $this);
        });

        unselectBlocks();
    } else {
        showNotification('Не выбраны блоки или цвет', true, 2000);
    }
}

// Import a saved page
function importSavedPage(file, json) {
    let counter = 0;
    const filesNum = _.size(json.blocks);
    const dir = path.dirname(file);
    const checkPath = path.join(dir, json.name);

    if (fs.existsSync(checkPath)) {
        const files = getAudioFilesInFolder(checkPath);
        if (files.length > 0) {
            counter = processJsonFiles(files, json);
        }
    } else {
        showFolderSelectionDialog(function (files) {
            counter = processJsonFiles(files, json);
        }, function () {
            showNotification('Добавлена страница <b>' + json.name + '</b>. Звуков: <b>' + counter + '</b>, пропущено: <b>' + (filesNum - counter) + '</b>');
        }, 'Выбери папку со звуками для страницы "' + json.name + '"');
    }

    return {
        added: counter,
        skipped: filesNum - counter
    };
}

// Export single page from database
function exportSavedPage(page, filePath) {
    const json = {
        type: 'page',
        hash: getStringHash(page.name),
        name: page.name
    };
    const blocks = {};

    if (page.added.length > 0) {
        json.added = page.added;
    }

    if (_.size(page.blocks) > 0) {
        _.each(page.blocks, function (block, hash) {
            blocks[hash] = _.omit(block, ['path', 'counter', 'addedDate', 'lastDate']);
        });
        json.blocks = blocks;
    }

    fs.writeFileSync(filePath, JSON.stringify(json, null, '\t'), 'utf-8');
}

// Intro to using the player
function startIntro() {
    tour = new Shepherd.Tour({
        defaultStepOptions: {
            cancelIcon: {
                enabled: true
            },
            tippyOptions: {
                maxWidth: '750px',
                distance: 0
            }
        },
        useModalOverlay: true,
        styleVariables: {
            shepherdThemePrimary: '#2B3E50',
            shepherdTextBackground: '#dee5ed'
        }
    });

    const steps = [{
        title: 'Здравствуй, друг-пранкер! Пройдем обучение?',
        text: 'Нажми <b>Начать</b>, чтобы пройти краткое обучение.<br>Если нет желания, кликай <b>Не сейчас</b> или на крестик.<br>Чтобы не видеть это окно, жми <b>Больше не показывать</b>.<br><b>Повторить</b> обучение можно через меню <b>О программе</b>.',
        classes: 'with-grinch',
        buttons: [
            {
                action: function () {
                    config.set('tutorial', true);
                    return this.cancel();
                },
                classes: 'button is-link',
                text: 'Больше не показывать'
            },
            {
                action: tour.cancel,
                classes: 'button',
                text: 'Не сейчас'
            },
            {
                action: tour.next,
                classes: 'button is-info',
                text: 'Начать'
            }
        ]
    }, {
        title: 'Главная область',
        text: 'В центре находится <b>главная область</b>, куда будут загружаться страницы со звуками.<br>Сверху — <b>панель вкладок</b>, справа от нее — иконка вызова <b>меню вкладок</b>.<br>Можно <b>изменять масштаб</b> интерфейса через <b>Ctrl + колесико</b> или клавишами <b>+/−</b>.',
        attachTo: {
            element: '.wrapper'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: '«Навигатор»',
        text: 'Это — <b>Навигатор</b>, в котором есть меню <b>Настроек</b> и <b>О программе</b>,<br>а также список всех добавленных <b>страниц</b> и <b>проектов</b>.<br>Списки можно <b>сортировать</b> (кнопкой A-Z справа) и <b>фильтровать</b> (вводя текст в поле).',
        attachTo: {
            element: '#navigator',
            on: 'right'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: '«Колода»',
        text: 'Это — <b>Колода</b>, в которой находятся все добавленные,<br>но <b>неразмещенные</b> на странице звуки.<br>Также здесь появляется <b>меню редактирования</b>.',
        attachTo: {
            element: '#deck',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Вход в режим редактирования',
        text: 'По умолчанию плеер запускается в режиме <b>воспроизведения</b>.<br>Чтобы начать добавлять звуки, нужно войти в режим <b>редактирования</b>.<br>Для этого <b>нажми на Пробел</b>, чтобы здесь появилось новое меню.<br><br><i>(сделай это сейчас, чтобы продолжить обучение)</i>',
        attachTo: {
            element: '#deck',
            on: 'left'
        },
        id: 'edit-mode'
    }, {
        title: 'Создание новой страницы',
        text: 'Теперь наведи мышь на <b>иконку со стрелкой</b> в <b>правом верхнем</b> углу и выбери вторую сверху <b>иконку с плюсом</b>.<br>Появится новая страница со случайным названием.<br><br><i>(сделай это сейчас, чтобы продолжить обучение)</i>',
        attachTo: {
            element: '.wrapper'
        },
        id: 'add-page'
    }, {
        title: 'Список страниц',
        text: 'Новые страницы автоматически добавляются в этот список.<br>Чтобы открыть их заново, <b>кликни</b> по ним <b>два раза</b> или <b>перетащи</b> в область вкладок.<br>Страницы можно <b>удалять</b>, нажав на <b>крестик</b> слева.',
        attachTo: {
            element: '#page-search',
            on: 'right'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Список вкладок',
        text: 'Слева от названий вкладок ты увидишь <b>цифры</b> или <b>буквы</b>.<br>Это — <b>горячие клавиши</b> для переключения вкладок с клавиатуры.<br>Чтобы <b>закрыть</b> вкладку, нажми на крестик или используй сочетание <b>Ctrl+W</b>.<br>Закрыть <b>все вкладки</b> можно <b>кнопкой</b> справа в меню или сочетанием <b>Ctrl+Alt+W</b>.',
        attachTo: {
            element: '#tabs',
            on: 'bottom'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Переименование страниц',
        text: 'Вкладки (страницы) можно переименовывать.<br>Для этого нажми на нее <b>правой кнопкой</b> мыши,<br>введи <b>новое название</b> и нажми <b>Enter</b>.<br><br><i>(сделай это сейчас, чтобы продолжить обучение)</i>',
        attachTo: {
            element: '.tab',
            on: 'bottom'
        },
        id: 'rename-page'
    }, {
        title: 'Меню редактирования',
        text: 'Отлично!<br>Теперь давай подробнее разберем кнопки <b>меню редактирования</b>.</i>',
        attachTo: {
            element: '.edit-mode',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Файлы»',
        text: 'Кнопка для добавления <b>звуковых файлов</b> в колоду.<br>В открывшемся окне выбрать <b>один или несколько</b> файлов через Ctrl или Shift.<br><b>Форматы</b>: mp3, mpeg, opus, ogg, oga, wav, aac, caf, m4a, mp4, weba, webm, dolby, flac.',
        attachTo: {
            element: '#add-sound',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Папки»',
        text: 'Кнопка для добавления <b>папок со звуками</b> в колоду.<br>В открывшемся окне выбрать <b>одну или несколько</b> папок через Ctrl или Shift.<br>Имей в виду, что если звуков много, процесс может занять несколько минут.',
        attachTo: {
            element: '#add-folder',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «PPv2»',
        text: 'Кнопка для <b>импорта</b> страницы в старом <b>формате Prank Player v2</b>.<br>В открывшемся окне выбрать <b>один файл prank.txt</b>.',
        attachTo: {
            element: '#add-pp',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Nx PPv2»',
        text: 'Кнопка для <b>массового импорта</b> страниц в старом <b>формате PPv2</b>.<br>В открывшемся окне выбрать <b>одну папку</b> со множеством <b>prank.txt</b> файлов.<br>Ищется также <b>внутри подпапок</b>, так что можно выбирать, например, всю папку MP3.<br>Имей в виду, что если страниц много, процесс может занять несколько минут.',
        attachTo: {
            element: '#add-ppx',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Цвет»',
        text: 'Кнопка <b>выбора цвета</b> для покраски блоков.',
        attachTo: {
            element: '#color-choose',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Применить»',
        text: 'Позволяет <b>применить цвет</b> к выделенным блокам.<br>Горячая клавиша: <b>Ctrl+D</b>.',
        attachTo: {
            element: '#color-apply',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Кисть»',
        text: 'Позволяет включить или выключить режим <b>покраски кистью</b>.<br>Выйти из режима Кисти можно также клавишей <b>Escape</b>.',
        attachTo: {
            element: '#color-brush',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Удалить»',
        text: 'Кнопка для <b>удаления всех блоков</b> со <b>страницы</b> обратно в <b>колоду</b>.',
        attachTo: {
            element: '#remove-main',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Сохранить»',
        text: 'Кнопка для ручного <b>сохранения базы данных</b><br>со страницами, звуками и их расположением.<br>Горячая клавиша: <b>Ctrl+S</b>.',
        attachTo: {
            element: '#save-all',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Импорт»',
        text: 'Кнопка для <b>импорта</b> страниц в <b>новом формате</b> JSON.<br>В открывшемся окне выбрать <b>один или несколько</b> файлов JSON через Ctrl или Shift.<br>Далее выбрать <b>папку со звуками</b>, которые были использованы на странице.<br>Чтобы папку не спрашивало, называйте ее <b>как страницу</b> и кладите <b>рядом с JSON</b>.',
        attachTo: {
            element: '#page-import',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Экспорт»',
        text: 'Кнопка для <b>экспорта</b> страниц в <b>новом формате</b> JSON.<br>В открывшемся окне выбрать <b>место сохранения</b> JSON-файла.',
        attachTo: {
            element: '#page-export',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Экспорт всех страниц»',
        text: 'Кнопка для <b>массового экспорта</b> всех страниц в <b>новом формате</b>.<br>В открывшемся окне выбрать <b>папку для сохранения</b> всех JSON-файлов.',
        attachTo: {
            element: '#batch-export',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Добавление файлов',
        text: 'Давай добавим пару файлов в колоду.<br>Нажми на кнопку <b>Файлы</b>, выбери <b>несколько звуков</b> и нажми <b>Открыть</b>.<br><br><i>(сделай это сейчас, чтобы продолжить обучение)</i>',
        attachTo: {
            element: '#deck',
            on: 'left'
        },
        id: 'add-file'
    }, {
        title: 'Список файлов в колоде',
        text: 'Это — <b>список</b> добавленных файлов (звуков).<br>Чтобы <b>прослушать</b> звук, нажми на него <b>правой кнопкой</b> мыши.<br>Чтобы <b>добавить</b> звук на страницу, <b>перетяни</b> его в <b>главную область</b>.<br>Также можно быстро добавить звук в пустое место <b>двойным кликом</b>.',
        attachTo: {
            element: '#deck',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Операции со списком файлов',
        text: 'Список можно <b>сортировать</b> по алфавиту или по длине названия.<br>Также можно <b>фильтровать</b> фразы по тексту.<br>Чтобы <b>удалить</b> звуки из колоды, <b>выдели</b> их <b>левой кнопкой мыши</b><br>от пустого места и нажми клавишу <b>Delete</b> на клавиатуре.',
        attachTo: {
            element: '#deck',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Массовое добавление на страницу',
        text: 'Это — поле для <b>массового добавления</b> звуков из колоды <b>на страницу</b>.<br>Введи желаемое <b>количество звуков</b> и нажми на кнопку <b>с плюсом</b> справа.<br>Звуки автоматически добавятся в пустое место с фиксированной шириной блока.',
        attachTo: {
            element: '.batch',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Очистка колоды',
        text: 'Кнопка <b>Очистить</b> позволяет <b>удалить</b> все оставшиеся фразы в колоде.',
        attachTo: {
            element: '#deck-bottom',
            on: 'top'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Операции с блоками',
        text: 'Блоки, добавленные на страницу, можно <b>перемещать</b>, а также менять их <b>размер</b>.<br>Быстро изменить размер можно, зажав <b>правую кнопку</b> мыши в любом месте блока.<br>Для <b>изменения текста</b> в блоке, кликни по нему <b>Ctrl + правой кнопкой</b> мыши.<br>Чтобы <b>массово переместить</b> блоки, выдели их через <b>Shift + левую кнопку</b> мыши.<br>Выделенные таким образом блоки можно также <b>удалить</b> в колоду клавишей <b>Delete</b>.<br>Чтобы прослушать звук на странице, можно <b>покрутить колесико</b> мыши на блоке.',
        attachTo: {
            element: '.wrapper'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Проекты',
        text: 'Текущий набор вкладок (страниц) можно сохранить как новый <b>проект</b>.<br>Проекты позволяют быстро открыть <b>сразу несколько</b> страниц.<br>Чтобы создать проект, наведи мышкой на иконку справа и нажми <b>Сохранить как</b>.<br>Горячая клавиша создания проекта: <b>Shift+Alt+S</b>.<br><b>Обновить</b> активный проект можно кнопкой <b>Перезаписать проект</b> или <b>Alt+S</b>.',
        attachTo: {
            element: '#tabs',
            on: 'bottom'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Список проектов',
        text: 'После сохранения проекты появляются здесь.<br>Чтобы открыть проект, <b>кликни</b> по нему <b>два раза</b>.<br>При этом все текущие вкладки <b>закроются</b> и новый проект станет <b>активным</b>.<br>Чтобы вкладки не закрывались, можно <b>добавить</b> проект к текущему <b>кнопкой</b> справа.',
        attachTo: {
            element: '#project-search',
            on: 'right'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Кнопка «Снять выделение»',
        text: 'Эта кнопка позволяет <b>снять выделение</b> с активного проекта.<br>Полезно, например, для того, чтобы случайно не перезаписать активный проект.<br>Или для того, чтобы <b>закончить</b> работу с проектами, но <b>не закрывать</b> вкладки.',
        attachTo: {
            element: '.close-proj',
            on: 'top'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Копирование и вставка блоков',
        text: 'Блоки также можно <b>копировать</b> и <b>вырезать</b> на другие страницы.<br>Для этого сначала <b>выдели</b> их и нажми <b>Ctrl+C</b> или <b>Ctrl+X</b>.<br>Затем перейди на другую страницу и нажми <b>Ctrl+V</b>.',
        attachTo: {
            element: '.wrapper'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Копирование и вставка фраз',
        text: 'То же самое можно делать и в <b>Колоде</b>.<br><b>Выдели</b> фразы, нажми <b>Ctrl+C</b> для копирования или <b>Ctrl+X</b> для вырезания,<br>и наконец <b>Ctrl+V</b> для вставки на другой странице.',
        attachTo: {
            element: '#deck',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Drag and drop',
        text: 'Еще один способ <b>добавить звуки</b> в колоду — перетащить их <b>из проводника</b>.<br>Просто включи режим <b>редактирования</b>, затем <b>выдели</b> файлы/папки в проводнике,<br><b>перетащи</b> их в область <b>колоды</b> и <b>отпусти</b> левую кнопку мыши.',
        attachTo: {
            element: '#deck',
            on: 'left'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Режим воспроизведения',
        text: 'Когда страница настроена, остается только войти в режим <b>воспроизведения</b>.<br>Для этого нажми на <b>Пробел</b> еще раз.<br>Звуки теперь можно воспроизводить простым <b>левым кликом</b> на блоке.<br><b>Остановить</b> воспроизведение в любом режиме можно,<br> кликнув <b>правой кнопкой</b> в главной области плеера.',
        attachTo: {
            element: '.wrapper'
        },
        buttons: [{
            action: tour.next,
            classes: 'button is-info',
            text: 'Дальше'
        }]
    }, {
        title: 'Обучение пройдено!',
        text: '<b>Поздравляю</b>! Ты прошел обучение.<br>Остались вопросы? Заходи в <a href="#" class="discord">Discord</a> на канал <b>#grinch-player</b>.<br>Увидеть плеер в действии можно на канале <a href="#" class="youtube">ArsenalGrinch</a>.<br><b>Удачи</b> и <b>успехов</b>!',
        classes: 'with-grinch',
        buttons: [
            {
                action: function () {
                    config.set('tutorial', true);
                    return this.complete();
                },
                classes: 'button is-success',
                text: 'Закончить обучение'
            }
        ]
    }];

    tour.addSteps(steps);

    tour.start();
}

// ==================== //
//                      //
//   Helper Functions   //
//                      //
// ==================== //

// Tour helper: advance if event was fired
function advanceIfTourStep(id) {
    if (tour !== undefined) {
        const stepId = tour.getCurrentStep().id;
        if (stepId === id) {
            tour.next();
        }
    }
}

// Autosize text inside block
function autoSizeText($elements) {
    $elements.find('.sound-text').each(function () {
        fancy.fillParentContainer(this, {
            maxFontSize: 400,
            maxWidth: $(this).parent().width() - 2,
            maxHeight: $(this).parent().height() - 2
        });
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
    return Number(farmhash.hash32(file)).toString(16);
}

// Get hex hash of a string
function getStringHash(text) {
    return Number(farmhash.hash32(text)).toString(16);
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
function toggleBodyClass(name) {
    $('body').toggleClass(name);
}

// Return HTML code for a tab
function getTabHtml(text, hash) {
    return '<li class="tab" data-page="' + hash + '">' +
        '<a class="link"><span class="icon fa-stack">' +
        '<i class="fa fa-circle fa-stack-2x"></i>' +
        '<strong class="fa-stack-1x">1</strong></span>' +
        '<span class="text">' + text + '</span>' +
        '<span class="icon tab-close" title="Закрыть (Ctrl+W)"><i class="fa fa-times"></i></span>' +
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

// Reset page search
function resetPageSearch() {
    pageSearch.list.search();
    $('#page-search .search').val('');
}

// Reset project search
function resetProjectSearch() {
    projectSearch.list.search();
    $('#project-search .search').val('');
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

// Check if block exists in active page
function activeBlockExists(hash) {
    return _.keys(allPages[currentTab].blocks).includes(hash);
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
    $('#project-search .is-active').removeClass('is-active');
}

// Unselect all selected blocks
function unselectBlocks() {
    $('.ui-selected').removeClass('ui-selected');
}

// Remove brush state
function removeBrushState() {
    $('#color-brush').removeClass('selected');
    $('body').removeClass('brush');
    $('.main').selectable('enable');
    $('.sound-block').draggable('enable').resizable('enable');
}

// Erase 'pages' folder with cached pages
function flushSavedPages() {
    const savedFiles = fg.sync('*.json', {
        cwd: path.join(remote.app.getPath('userData'), 'pages'),
        onlyFiles: true,
        absolute: true
    });

    savedFiles.forEach(function (file) {
        fs.unlinkSync(file);
    });
}

// Process files found in exported json
function processJsonFiles(files, json) {
    let counter = 0;

    for (const file of files) {
        const hash = getFileHash(file);
        if (_.keys(json.blocks).includes(hash) && json.blocks[hash].path === undefined) {
            json.blocks[hash].path = path.normalize(file);
            json.blocks[hash].addedDate = new Date().toISOString();
            json.blocks[hash].counter = 0;
            counter++;
        }
    }

    json = _.omit(filterBlocksWithoutPath(json), ['type']);

    if (counter > 0) {
        addPageToDatabase(json);
    }

    return counter;
}

function closeQuickSearch() {
    $quickSearch.removeClass('active');
    document.activeElement.blur();
    $('.is-searched, .is-found').removeClass('is-searched is-found');
}

function infoTipsShow(tip, tag, phrase, bound) {
    const hash = tip.reference.dataset[tag];
    let element;
    if (tag === 'hash') {
        element = allPages[currentTab].blocks[hash];
    } else {
        element = allPages[hash];
    }

    const addedDate = moment.utc(element.addedDate);
    const lastDate = moment.utc(element.lastDate);
    const addedDiff = moment().diff(addedDate, 'days');
    const lastDiff = moment().diff(lastDate, 'days');
    tip.set({
        boundary: bound,
        content: '<p>' + phrase + '<b> ' + element.counter + '</b> раз(а)</p>' +
            '<p>Последний: <b>' + lastDiff + '</b> дн. (' +
            lastDate.format('D MMM YY') + ')</p>' +
            '<p>Добавлено: <b>' + addedDiff + '</b> дн. (' +
            addedDate.format('D MMM YY') + ')</p>'
    });
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
    $quickSearch = $('#quick-search');
    $tabList = $('#tabs > ul');
    $wrapper = $('.wrapper');

    // Set moment.js locale globally
    moment.locale('ru');

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

    // Set default global volume
    hp.Howler.volume(volume);

    // Settings and About tooltips
    tippy(document.querySelector('#settings'), {
        content: '<div class="panel settings-panel">' +
            '<p class="panel-heading">Настройки</p>' +
            '<a class="panel-block set-device" title="Выбрать устройство вывода звука"><i class="fa fa-gear"></i> Устройство вывода</a>' +
            '<a class="panel-block flush-cache" title="Очистить кеш (сначала закрой вкладки)"><i class="fa fa-eraser"></i> Очистить кеш страниц</a>' +
            '<div class="panel-block"><i class="fa fa-volume-up"></i> Громкость' +
            '<input id="volume-slider" class="slider has-output is-fullwidth" min="0" max="100"' +
            ' value="' + (volume * 100) + '" step="1" type="range"></div>' +
            '<a class="panel-block info-tips" title="Информационные подсказки"><i class="fa fa-toggle-off"></i> Инфо-подсказки</a>' +
            '</div>',
        arrow: true,
        aria: null,
        trigger: 'click',
        theme: 'green',
        interactive: true,
        placement: 'right'
    });

    tippy(document.querySelector('#about'), {
        content: '<div class="panel about-panel">' +
            '<p class="panel-heading">О программе</p>' +
            '<a class="panel-block show-info" title="Описание плеера"><i class="fa fa-info-circle"></i> Описание</a>' +
            '<a class="panel-block show-help" title="Справка по плееру"><i class="fa fa-question-circle"></i> Помощь</a>' +
            '<a class="panel-block start-intro" title="Пройти интерактивное обучение"><i class="fa fa-star"></i> Обучение</a>' +
            '<a class="panel-block discord" title="Обсуждение в #grinch-player"><i class="fa fa-discord-alt"></i> Discord</a>' +
            '<a class="panel-block youtube" title="Канал Гринча"><i class="fa fa-youtube-play"></i> ArsenalGrinch</a>' +
            '<a class="panel-block check-updates" title="Открыть страницу на GitHub"><i class="fa fa-external-link-square"></i> Обновления</a>' +
            '</div>',
        arrow: true,
        aria: null,
        trigger: 'click',
        theme: 'green',
        interactive: true,
        placement: 'right'
    });

    tippy(document.querySelector('#color-choose'), {
        content: '<div class="panel">' +
            '<p class="panel-heading">Выбрать цвет</p>' +
            '<div class="panel-block colors">' +
            '<div class="color bg-yellow" data-color="yellow">Dark Yellow</div>' +
            '<div class="color bg-amber" data-color="amber">Amber</div>' +
            '<div class="color bg-deep-orange" data-color="deep-orange">Orange</div>' +
            '<div class="color bg-orange" data-color="orange">Deep Orange</div>' +
            '<div class="color bg-red" data-color="red">Red</div>' +
            '<div class="color bg-pink" data-color="pink">Pink</div>' +
            '<div class="color bg-indigo" data-color="indigo">Indigo</div>' +
            '<div class="color bg-purple" data-color="purple">Purple</div>' +
            '<div class="color bg-deep-purple" data-color="deep-purple">Deep Purple</div>' +
            '<div class="color bg-cyan" data-color="cyan">Cyan</div>' +
            '<div class="color bg-blue" data-color="blue">Blue</div>' +
            '<div class="color bg-light-blue" data-color="light-blue">Light Blue</div>' +
            '<div class="color bg-teal" data-color="teal">Teal</div>' +
            '<div class="color bg-green" data-color="green">Green</div>' +
            '<div class="color bg-light-green" data-color="light-green">Light Green</div>' +
            '<div class="color bg-lime" data-color="lime">Lime</div>' +
            '<div class="color bg-brown" data-color="brown">Brown</div>' +
            '<div class="color bg-light-brown" data-color="light-brown">Light Brown</div>' +
            '<div class="color bg-grey" data-color="grey">Grey</div>' +
            '<div class="color bg-black" data-color="black">Black</div>' +
            '<div class="color bg-default" data-color="default">Default</div>' +
            '</div></div>',
        arrow: true,
        aria: null,
        trigger: 'click',
        theme: 'green',
        interactive: true,
        placement: 'left'
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
                    showNotification('Такая вкладка уже есть!', true, 1500);
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
        // Tab change event (page change)
        if (activePages[currentTab] !== undefined) {
            resetDeckList();
        }

        unselectBlocks();
        closeQuickSearch();
        currentTab = e.currentTarget.dataset.page;

        const selector = '[data-page="' + currentTab + '"]';
        $main = $('.main' + selector);
        $deckItems = $('.deck-items' + selector);
        updateDeckData();

        const query = '.main, .panel-tabs, .deck-items, .deck .search';
        document.querySelectorAll(query).forEach(function (el) {
            el.style.display = 'none';
        });

        document.querySelectorAll(selector).forEach(function (el) {
            if (!el.classList.contains('page') && !el.classList.contains('tab')) {
                el.style.display = 'block';
            }
        });

        $(e.delegateTarget).find('.is-active').removeClass('is-active');
        $(e.currentTarget).addClass('is-active');

        allPages[currentTab].counter += 1;
    }).on('contextmenu', '.tab', function (e) {
        e.preventDefault();
        if (isEditMode) {
            $(e.currentTarget).find('.text').trigger('edit');
        }
    }).on('click', '.tab-close', function (e) {
        e.stopPropagation();
        const $this = $(this);
        const hash = $this.closest('.tab').attr('data-page');
        actionWithLoading(function () {
            closeTab(hash);
            updateMainHeight();
        });
    });

    // Show tooltip with buttons in Edit mode
    tippy(document.querySelector('#tab-actions'), {
        content: '<div class="block-controls">' +
            '<button class="button close-tabs" title="Закрыть все вкладки (Ctrl+Alt+W)"><i class="fa fa-times-circle"></i></button>' +
            '<button class="button add-tab" title="Добавить вкладку"><i class="fa fa-plus-circle"></i></button>' +
            '<button class="button proj-save" title="Перезаписать проект (Alt+S)"><i class="fa fa-floppy-o"></i></button>' +
            '<button class="button proj-saveas" title="Сохранить как… (Shift+Alt+S)"><i class="fa fa-file-text"></i></button>' +
            '</div>',
        arrow: true,
        aria: null,
        distance: 5,
        interactive: true,
        placement: 'bottom'
    });

    // Init page search
    pageSearch.bar = new SBar(document.querySelector('#page-search .items'));
    pageSearch.list = new List('page-search', {
        valueNames: ['text'],
        listClass: 'simplebar-content'
    });

    // Init project search
    projectSearch.bar = new SBar(document.querySelector('#project-search .items'));
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
    _.keys(allProjects).forEach(function (proj) {
        addProjectToList(proj, allProjects[proj].name);
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

    // Add block from single or multiple files
    $('#add-sound').click(function () {
        if (_.size(activePages) > 0) {
            $wrapper.addClass('is-loading');

            dialog.showOpenDialog({
                title: 'Выбери звуки',
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
                    advanceIfTourStep('add-file');
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
            const pageName = allPages[currentTab].name;
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
                    exportSavedPage(allPages[currentTab], filePath);
                    $wrapper.removeClass('is-loading');
                    showNotification('Сохранено в <b>' + fileName + '</b>');
                }
            });
        } else {
            showNotification('Нет активной страницы', true, 1500);
        }
    });

    // Export all pages
    $('#batch-export').click(function () {
        if (_.size(allPages) > 0) {
            $wrapper.addClass('is-loading');

            dialog.showOpenDialog({
                title: 'Выбери папку для экспорта',
                properties: ['openDirectory']
            }, function (dirs) {
                if (dirs === undefined) {
                    $wrapper.removeClass('is-loading');
                } else {
                    const dirName = path.basename(dirs[0]);
                    const pageCount = _.size(allPages);

                    _.keys(allPages).forEach(function (pageHash) {
                        const page = allPages[pageHash];
                        const filePath = path.join(dirs[0], getPageName(page.name));
                        exportSavedPage(page, filePath);
                    });

                    showNotification('Экспортировано страниц: <b>' + pageCount + '</b> в папку <b>' + dirName + '</b>');

                    $wrapper.removeClass('is-loading');
                }
            });
        } else {
            showNotification('В базе нет сохраненных страниц', true, 1500);
        }
    });

    // Import a page from a file
    $('#page-import').click(function () {
        $wrapper.addClass('is-loading');

        dialog.showOpenDialog({
            title: 'Выбери сохраненную страницу',
            properties: ['openFile', 'multiSelections'],
            filters: [{
                name: 'JSON',
                extensions: ['json']
            }]
        }, function (files) {
            if (files === undefined) {
                $wrapper.removeClass('is-loading');
            } else {
                let addedCount = 0;
                let skippedCount = 0;
                let pageCount = 0;

                files.forEach(function (file) {
                    const json = JSON.parse(fs.readFileSync(file));

                    if (json.type && json.type === 'page' && !pageExists(json.hash)) {
                        const result = importSavedPage(file, json);
                        addedCount += result.added;
                        skippedCount += result.skipped;
                        pageCount++;
                    }
                });

                if (pageCount > 0 && addedCount > 0) {
                    showNotification('Добавлено страниц: <b>' + pageCount + '</b>. Звуков: <b>' + addedCount + '</b>, пропущено: <b>' + skippedCount + '</b>', false, 5000);
                }

                if (pageCount === 0) {
                    showNotification('Новых страниц <b>не найдено</b>', true, 3000);
                }

                $wrapper.removeClass('is-loading');
            }
        });
    });

    // Remove all added blocks
    $('#remove-main').click(function () {
        if (_.size(activePages) > 0 && allPages[currentTab].added.length > 0) {
            const count = allPages[currentTab].added.length;
            stopCurrentSound();
            if (confirmAction('Удалить ВСЕ блоки со страницы в колоду?') === 1) {
                actionWithLoading(function () {
                    flushAddedBlocks();
                    updateDeckData();
                    showNotification('Удалено со страницы: <b>' + count + '</b>', false, 3000);
                });
            }
        } else {
            showNotification('Удалять нечего', true, 1500);
        }
    });

    // Save all pages and projects to DB
    $('#save-all').click(function () {
        saveAllData();
    });

    // Import one PPv2 file
    $('#add-pp').click(function () {
        $wrapper.addClass('is-loading');

        dialog.showOpenDialog({
            title: 'Выбери файл prank.txt из PrankPlayer v2',
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
                    $wrapper.removeClass('is-loading');
                    showNotification('Добавлена страница <b>' + result.name + '</b>. Звуков: <b>' + result.added + '</b>, пропущено: <b>' + result.skipped + '</b>');
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
            title: 'Выбери папку со вложенными папками (напр. mp3)',
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

                    if (pageCount > 0) {
                        showNotification('Добавлено страниц: <b>' + pageCount + '</b>. Звуков: <b>' + addedCount + '</b>, пропущено: <b>' + skippedCount + '</b>', false, 5000);
                    } else {
                        showNotification('Новых страниц <b>не найдено</b>', true, 3000);
                    }
                }

                $wrapper.removeClass('is-loading');
            }
        });
    });

    // Apply color to selected blocks
    $('#color-apply').click(function () {
        if (_.size(activePages) > 0) {
            applySelectedBlockColor();
        }
    });

    // Apply color to selected blocks
    $('#color-brush').click(function () {
        if (_.size(activePages) > 0) {
            const $this = $(this);

            if ($this.hasClass('selected')) {
                removeBrushState();
            } else {
                $this.addClass('selected');
                $('body').addClass('brush');
                $('.main').selectable('disable');
                $('.sound-block').draggable('disable').resizable('disable');
            }
        }
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

        // Shift key
        if (e.which === 16 && !e.originalEvent.repeat) {
            $('body').addClass('events-none');
        }
    }).keyup(function (e) {
        if (e.which === 16) {
            $('body').removeClass('events-none');
        }
    }).on('keydown', '#deck .search', function (e) {
        // Escape erases search
        if (e.which === 27) {
            resetDeckList();
        }
    }).on('keydown', '#page-search .search', function (e) {
        if (e.which === 27) {
            resetPageSearch();
        }
    }).on('keydown', '#project-search .search', function (e) {
        if (e.which === 27) {
            resetProjectSearch();
        }
    }).on('keydown', '#proj-create .input', function (e) {
        // Enter in project input
        if (e.which === 13) {
            projectSaveAction(e.target);
        }
    }).on('keydown', '#quick-search .input', function (e) {
        // Close quick search input
        if (e.which === 27 && $quickSearch.hasClass('active')) {
            closeQuickSearch();
        }
    }).on('wheel', function (e) {
        if (e.ctrlKey) {
            const delta = e.originalEvent.deltaY;
            updateZoom(delta);
        }
    }).on('mouseenter', '.main', function () {
        // Remove focus from active inputs so the hotkeys work fine
        // document.activeElement.blur();
    }).on('click', '.close-tabs', function () {
        if (_.size(activePages) > 0) {
            actionWithLoading(function () {
                closeAllTabs();
                unselectProjects();
            });
        }
    }).on('click', '.add-tab', function () {
        if (isEditMode) {
            addNewEmptyPage();
            tabClick(false);
            advanceIfTourStep('add-page');
        }
    }).on('click', '.proj-saveas', function () {
        projectSaveAs();
    }).on('click', '.btn-saveas', function () {
        projectSaveAction(this);
    }).on('click', '.close-proj', function () {
        unselectProjects();
    }).on('click', '.proj-save', function () {
        projectSaveButton();
    }).on('click', '.settings-panel a.panel-block', function () {
        document.querySelector('#settings')._tippy.hide();
    }).on('click', '.set-device', function () {
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
    }).on('click', '.flush-cache', function () {
        flushSavedPages();
        showNotification('Кеш страниц очищен!', false, 3000);
    }).on('click', '.info-tips', function () {
        $(this).find('.fa').toggleClass('fa-toggle-off fa-toggle-on');

        if (infoTipsActive) {
            infoTipsActive = false;
            showNotification('Инфо-подсказки <b>выключены</b>', false, 2000);
        } else {
            infoTipsActive = true;
            showNotification('<b>Включены</b> инфо-подсказки', false, 2000);
        }
    }).on('click', '.about-panel a.panel-block', function () {
        document.querySelector('#about')._tippy.hide();
    }).on('click', '.show-help', function () {
        $('#help').addClass('is-active');
    }).on('click', '.show-info', function () {
        $('#info').addClass('is-active');
    }).on('click', '.start-intro', function () {
        startIntro();
    }).on('click', '.youtube', function () {
        shell.openExternal('https://www.youtube.com/user/arsenalgrinch');
    }).on('click', '.discord', function () {
        shell.openExternal('https://discord.gg/EEkpKp2');
    }).on('click', '.check-updates', function () {
        shell.openExternal('https://github.com/n3tman/GrinchPlayer/releases');
    }).on('click', '.releases', function () {
        shell.openExternal('https://github.com/n3tman/GrinchPlayer/releases');
    }).on('click', '.repository', function () {
        shell.openExternal('https://github.com/n3tman/GrinchPlayer');
    }).on('click', '.license', function () {
        shell.openExternal('https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ru');
    }).on('input', '#volume-slider', function () {
        volume = this.value / 100;
        hp.Howler.volume(volume);
        showNotification('Громкость: ' + this.value + '%', false, 1500);
    }).on('click', '.colors > .color', function (e) {
        const color = e.target.dataset.color;
        const $button = $('#color-choose');

        if (selectedColor !== undefined) {
            $button.removeClass('bg-' + selectedColor);
        }

        selectedColor = color;

        $button.addClass('bg-' + color);
        $button[0]._tippy.hide();
    }).on('mousedown mouseenter', '.sound-block', function (e) {
        if (isEditMode && selectedColor !== undefined && $('body').hasClass('brush') && e.buttons === 1) {
            const hash = e.currentTarget.dataset.hash;
            const $block = $(e.currentTarget);
            applySingleBlockColor(hash, $block);
        }
    });

    // ----------- //
    //  Navigator  //
    // ----------- //

    $('#page-search').on('click', '.page-remove', function () {
        if (isEditMode) {
            const $parent = $(this).parent();
            const hash = $parent.attr('data-page');

            if (confirmAction('Удалить страницу ' + allPages[hash].name.toUpperCase() + ' из базы?') === 1) {
                actionWithLoading(function () {
                    if (_.keys(activePages).includes(hash)) {
                        closeTab(hash);
                    }

                    $parent.remove();
                    updatePageSearch();

                    delete allPages[hash];

                    // Remove page from all projects
                    _.keys(allProjects).forEach(function (proj) {
                        const index = allProjects[proj].pages.indexOf(hash);
                        if (index > -1) {
                            allProjects[proj].pages.splice(index, 1);
                        }
                    });
                });
            }
        }
    });

    $('#project-search').on('click', '.proj-remove', function () {
        if (isEditMode) {
            const $parent = $(this).parent();
            const hash = $parent.attr('data-proj');

            if (confirmAction('Удалить проект ' + allProjects[hash].name.toUpperCase() + ' из базы?') === 1) {
                actionWithLoading(function () {
                    if (hash === currentProject) {
                        currentProject = '';
                    }

                    $parent.remove();
                    updateProjectSearch();

                    delete allProjects[hash];
                });
            }
        }
    }).on('click', '.proj-add', function () {
        const hash = this.parentElement.dataset.proj;
        actionWithLoading(function () {
            loadProjectTabs(hash);

            if (currentTab === '') {
                tabClick(true);
            }
        });
    });

    // -------------- //
    //  Deck sidebar  //
    // -------------- //

    $('#deck').on('contextmenu', '.deck-items .panel-block', function () {
        playSound(this);
    }).on('click', '#batch-btn', function () {
        if (isEditMode && _.size(activePages) > 0) {
            // Batch add several blocks from the top
            resetDeckList();
            const num = $('#batch-num').val();
            const $items = $deckItems.find('.panel-block');
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

                    showNotification('Добавлено блоков: <b>' + count + '</b>', false, 3000);

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
        if (isEditMode && e.originalEvent.dataTransfer !== undefined) {
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
        if (isEditMode && _.size(activePages) > 0 && _.size(allPages[currentTab].blocks) > 0) {
            const before = _.size(allPages[currentTab].blocks);
            stopCurrentSound();

            const choice = confirmAction('Удалить ВСЕ звуки из колоды?', [
                'Нет', 'Да, только из базы', 'Да, вместе с файлами'
            ]);

            if (choice === 1 || choice === 2) {
                actionWithLoading(function () {
                    const withFiles = (choice === 2);
                    flushDeckItems(withFiles);
                    showNotification('Удалено из колоды: <b>' +
                        (before - _.size(allPages[currentTab].blocks)) + '</b>', false, 2000);
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
            showNotification('Устройство установлено!', false, 1500);
        }
    });

    // -------------------- //
    //  Update DB <= 1.5.0  //
    // -------------------- //

    $('#update-base').click(function () {
        if (_.keys(allPages)[0].length < 12) {
            showNotification('Исправление не требуется!', false, 3000);
        } else {
            actionWithLoading(function () {
                const newAllPages = {};
                const newAllProjects = {};

                _.keys(allPages).forEach(function (pageHash) {
                    const page = allPages[pageHash];
                    const newHash = getStringHash(page.name);
                    newAllPages[newHash] = _.cloneDeep(page);
                    newAllPages[newHash].hash = newHash;
                    newAllPages[newHash].added = [];
                    newAllPages[newHash].blocks = {};

                    if (currentTab === pageHash) {
                        currentTab = newHash;
                    }

                    if (activePageExists(pageHash)) {
                        $('[data-page="' + pageHash + '"]').attr('data-page', newHash);
                    }

                    _.keys(page.blocks).forEach(function (hash) {
                        const block = page.blocks[hash];
                        const blockHash = getFileHash(block.path);
                        newAllPages[newHash].blocks[blockHash] = _.cloneDeep(page.blocks[hash]);
                        if (page.added.includes(hash)) {
                            newAllPages[newHash].added.push(blockHash);
                        }
                    });
                });

                _.keys(allProjects).forEach(function (projHash) {
                    const proj = allProjects[projHash];
                    const newHash = getStringHash(proj.name);
                    newAllProjects[newHash] = _.cloneDeep(proj);
                    newAllProjects[newHash].pages = [];

                    if (currentProject === projHash) {
                        currentProject = newHash;
                    }

                    proj.pages.forEach(function (pageHash) {
                        newAllProjects[newHash].pages.push(
                            getStringHash(allPages[pageHash].name)
                        );
                    });
                });

                allPages = newAllPages;
                allProjects = newAllProjects;

                activePages = {};

                flushSavedPages();
            });

            showNotification('Готово! Перезапусти плеер');
        }
    });

    // Start the intro
    if (!tutorial) {
        startIntro();
    }

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

    // Save all data
    addHotkey('alt+s', function () {
        projectSaveButton();
    });

    // Save project as
    addHotkey('shift+alt+s', function () {
        projectSaveAs();
    });

    // Esc to close modals
    addHotkey('esc', function () {
        $('.modal.is-active').removeClass('is-active');
        if (isEditMode) {
            removeBrushState();
        }

        if ($quickSearch.hasClass('active')) {
            closeQuickSearch();
        }
    });

    // Close current tab
    addHotkey('ctrl+w', function () {
        if (_.size(activePages) > 0) {
            actionWithLoading(function () {
                closeTab(currentTab);
                updateMainHeight();
            });
        }
    });

    // Close all tabs
    addHotkey('ctrl+alt+w', function () {
        if (_.size(activePages) > 0) {
            actionWithLoading(function () {
                closeAllTabs();
                unselectProjects();
            });
        }
    });

    // Quick switch keys 1-10
    [1, 2, 3, 4, 5].forEach(function (val, i) {
        addHotkey(val.toString(), function () {
            $tabList.find('li').eq(i).click();
        });
    });

    // Quick switch keys 11-20
    keyboardArray.forEach(function (val, i) {
        addHotkey(val, function () {
            $tabList.find('li').eq(i + 5).click();
        });
    });

    // Global scope
    hotkeys('*', function (e) {
        if (e.key === '-') {
            updateZoom(1);
        }

        if (e.key === '=' || e.key === '+') {
            updateZoom(-1);
        }
    });

    // Remove selected blocks
    addHotkey('delete', function () {
        const $selected = $('.ui-selected');

        if (isEditMode && $selected.length > 0) {
            actionWithLoading(function () {
                if ($selected.first().parent().hasClass('main')) {
                    $main.find('.ui-selected').each(function () {
                        const hash = this.dataset.hash;
                        removeBlockFromPage(hash);
                        _.pull(allPages[currentTab].added, hash);
                    });
                    updateDeckData();
                } else {
                    const choice = confirmAction('Удалить выделенные звуки из колоды?', [
                        'Нет', 'Да, только из базы', 'Да, вместе с файлами'
                    ]);

                    if (choice === 1 || choice === 2) {
                        const $selected = $deckItems.find('.ui-selected');

                        $selected.each(function () {
                            const hash = this.dataset.hash;
                            const filePath = allPages[currentTab].blocks[hash].path;
                            howlDb[hash].unload();

                            if (choice === 2 && fs.existsSync(filePath)) {
                                fs.unlinkSync(filePath);
                            }

                            delete allPages[currentTab].blocks[hash];
                            $(this).remove();
                        });

                        updateDeckData();

                        showNotification('Удалено из колоды: <b>' + $selected.length + '</b>', false, 2000);
                    }
                }
            });
        }
    });

    // Copy blocks or deck items
    addHotkey('ctrl+c', function () {
        selectedBlocksAction('Скопировано');
    });

    // Cut blocks or deck items
    addHotkey('ctrl+x', function () {
        selectedBlocksAction('Вырезано', function ($this, hash) {
            $this.remove();
            _.pull(allPages[currentTab].added, hash);
            delete allPages[currentTab].blocks[hash];
            howlDb[hash].unload();
        });
    });

    // Paste blocks or deck items
    addHotkey('ctrl+v', function () {
        if (isEditMode && _.size(blockBuffer.blocks) > 0) {
            let counter = 0;

            _.keys(blockBuffer.blocks).forEach(function (hash) {
                if (!activeBlockExists(hash)) {
                    const selector = '[data-hash="' + hash + '"]';

                    allPages[currentTab].blocks[hash] = blockBuffer.blocks[hash];
                    allPages[currentTab].blocks[hash].counter = 0;
                    allPages[currentTab].blocks[hash].addedDate = new Date().toISOString();

                    if (blockBuffer.type === 'main') {
                        allPages[currentTab].added.push(hash);
                        addSavedSoundBlock(hash, currentTab, blockBuffer);
                        initDraggableMain($main.find(selector), true);
                    } else {
                        appendDeckItemHtml(hash, blockBuffer.blocks[hash].text);
                        initDeckEditable($deckItems.find(selector), true);
                    }

                    counter++;
                }
            });

            if (blockBuffer.type === 'deck') {
                updateDeckData();
            }

            showNotification('Вставлено: <b>' + counter + '</b>. Пропущено: <b>' +
                (_.size(blockBuffer.blocks) - counter) + '</b>', false, 2000);
        }
    });

    // Apply color to blocks hotkey
    addHotkey('ctrl+d', function () {
        applySelectedBlockColor();
    });

    // Toggle left sidebar
    addHotkey('ctrl+1', function () {
        $('#navigator').toggleClass('hide');
    });

    // Toggle right sidebar
    addHotkey('ctrl+2', function () {
        $('#deck').toggleClass('hide');
    });

    // ------------- //
    //  Search page  //
    // ------------- //

    const fuseOptions = {
        threshold: 0.5,
        keys: ['text']
    };

    let fuseArray;

    // Close current tab
    addHotkey('ctrl+f', function () {
        $quickSearch.addClass('active');
        if ($quickSearch.hasClass('active')) {
            $quickSearch.find('.input').val('').focus();
        }

        fuseArray = _.map(allPages[currentTab].blocks, function (val, key) {
            val.id = key;
            return val;
        });
        fuseSearch = new Fuse(fuseArray, fuseOptions);
    });

    // Input change event
    $quickSearch.find('.input').on('input', _.debounce(function () {
        const value = this.value.trim();
        $('.is-found').removeClass('is-found');

        if (value) {
            $main.addClass('is-searched');
            fuseSearch.search(value).forEach(function (val) {
                $main.find('[data-hash="' + val.id + '"]').addClass('is-found');
            });
        } else {
            $main.removeClass('is-searched');
        }
    }, 250));

    // --------------- //
    //  Info Tooltips  //
    // --------------- //

    tippy(document.querySelector('.wrapper'), {
        target: '.sound-block',
        theme: 'info',
        distance: 5,
        arrow: true,
        aria: null,
        onShow: function (tip) {
            if ($main && infoTipsActive) {
                infoTipsShow(tip, 'hash', 'Проигрывался', $main[0]);
            } else {
                return false;
            }
        }
    });

    tippy(document.querySelector('.deck'), {
        target: '.deck-items .panel-block',
        theme: 'info',
        distance: 5,
        arrow: true,
        placement: 'left',
        aria: null,
        onShow: function (tip) {
            if ($main && infoTipsActive) {
                infoTipsShow(tip, 'hash', 'Проигрывался', $main[0]);
            } else {
                return false;
            }
        }
    });

    tippy(document.querySelector('.pages'), {
        target: '.panel-block',
        theme: 'info',
        arrow: true,
        placement: 'right',
        aria: null,
        onShow: function (tip) {
            if (infoTipsActive) {
                infoTipsShow(tip, 'page', 'Открывалась', 'window');
            } else {
                return false;
            }
        }
    });
});
