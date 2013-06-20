/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, $, PathUtils, window, Mustache */

/*
 * Adds a "find in files" command to allow the user to find all occurances of a string in all files in
 * the project.
 * 
 * The keyboard shortcut is Cmd(Ctrl)-Shift-F.
 *
 * FUTURE:
 *  - Proper UI for both dialog and results
 *  - Refactor dialog class and share with Quick File Open
 *  - Search files in working set that are *not* in the project
 *  - Handle matches that span mulitple lines
 *  - Refactor UI from functionality to enable unit testing
 */


define(function (require, exports, module) {
    "use strict";
    
    var Async                 = require("utils/Async"),
        Resizer               = require("utils/Resizer"),
        CommandManager        = require("command/CommandManager"),
        Commands              = require("command/Commands"),
        Strings               = require("strings"),
        StringUtils           = require("utils/StringUtils"),
        ProjectManager        = require("project/ProjectManager"),
        DocumentManager       = require("document/DocumentManager"),
        EditorManager         = require("editor/EditorManager"),
        PanelManager          = require("view/PanelManager"),
        FileIndexManager      = require("project/FileIndexManager"),
        FileViewController    = require("project/FileViewController"),
        FileUtils             = require("file/FileUtils"),
        KeyEvent              = require("utils/KeyEvent"),
        AppInit               = require("utils/AppInit"),
        CollectionUtils       = require("utils/CollectionUtils"),
        StatusBar             = require("widgets/StatusBar"),
        ModalBar              = require("widgets/ModalBar").ModalBar;
    
    var searchDialogTemplate  = require("text!htmlContent/search-dialog.html"),
        searchPanelTemplate   = require("text!htmlContent/search-panel.html"),
        searchResultsTemplate = require("text!htmlContent/search-results.html");
    
	/** @cost Constants used to define the maximum results show per page and found in a single file */
	var RESULTS_PER_PAGE = 100,
        FIND_IN_FILE_MAX = 300;
	
    /**
     * Map of all the last search results
     * @type {Object.<fullPath: string, {matches: Array.<Object>, collapsed: boolean}>}
     */
    var searchResults = {};
    
    /** @type {Panel} Bottom panel holding the search results. Initialized in htmlReady() */
    var searchResultsPanel;
    
    /** @type {number} The index of the first result that is displayed */
    var currentStart = 0;
    
    /** @type {string} The current search query */
    var currentQuery = "";
    
    /** @type {Array.<FileEntry>} An array of the files where it should look or null/empty to search the entire project */
    var currentScope = null;
    
    /** @type {boolean} True if the matches in a file reached FIND_IN_FILE_MAX */
    var maxHitsFoundInFile = false;
    
    /** @type {$.Element} jQuery elements used in the search results */
    var $searchResults,
        $searchSummary,
        $searchContent,
        $selectedRow;
    
    
    /**
     * @private
     * Returns a regular expression from the given query and shows an error in the modal-bar if it was invalid
     * @param {!string} query - The query from the modal-bar input
     * @return {RegExp}
     */
    function _getQueryRegExp(query) {
        // Clear any pending RegEx error message
        $(".modal-bar .message").css("display", "inline-block");
        $(".modal-bar .error").css("display", "none");

        // If query is a regular expression, use it directly
        var isRE = query.match(/^\/(.*)\/(g|i)*$/);
        if (isRE) {
            // Make sure the 'g' flag is set
            var flags = isRE[2] || "g";
            if (flags.search("g") === -1) {
                flags += "g";
            }
            try {
                return new RegExp(isRE[1], flags);
            } catch (e) {
                $(".modal-bar .message").css("display", "none");
                $(".modal-bar .error")
                    .css("display", "inline-block")
                    .html("<div class='alert' style='margin-bottom: 0'>" + e.message + "</div>");
                return null;
            }
        }

        // Query is a string. Turn it into a case-insensitive regexp
        
        // Escape regex special chars
        query = StringUtils.regexEscape(query);
        return new RegExp(query, "gi");
    }
    
    /**
     * Returns label text to indicate the search scope. Already HTML-escaped.
     * @param {?Entry} scope
     */
    function _labelForScope(scope) {
        var projName = ProjectManager.getProjectRoot().name;
        if (scope) {
            return StringUtils.format(
                Strings.FIND_IN_FILES_SCOPED,
                StringUtils.breakableUrl(
                    ProjectManager.makeProjectRelativeIfPossible(scope.fullPath)
                )
            );
        } else {
            return Strings.FIND_IN_FILES_NO_SCOPE;
        }
    }
    
    
    // This dialog class was mostly copied from QuickOpen. We should have a common dialog
    // class that everyone can use.
    
    /**
     * FindInFilesDialog class
     * @constructor
     */
    function FindInFilesDialog() {
        this.closed = false;
        this.result = null; // $.Deferred
    }

    /**
     * Closes the search dialog and resolves the promise that showDialog returned
     */
    FindInFilesDialog.prototype._close = function (value) {
        if (this.closed) {
            return;
        }
        
        this.closed = true;
        this.modalBar.close();
        EditorManager.focusEditor();
        this.result.resolve(value);
    };
    
    /**
     * Shows the search dialog
     * @param {?string} initialString Default text to prepopulate the search field with
     * @param {?Entry} scope Search scope, or null to search whole proj
     * @returns {$.Promise} that is resolved with the string to search for
     */
    FindInFilesDialog.prototype.showDialog = function (initialString, scope) {
        // Note the prefix label is a simple "Find:" - the "in ..." part comes after the text field
        var templateVars = {
            value: initialString || "",
            label: _labelForScope(scope)
        };
        var dialogHTML = Mustache.render(searchDialogTemplate, $.extend(templateVars, Strings));
        
        this.result = new $.Deferred();
        this.modalBar = new ModalBar(dialogHTML, false);
        var $searchField = $("input#searchInput");
        var that = this;
        
        $searchField.get(0).select();
        $searchField
            .bind("keydown", function (event) {
                if (event.keyCode === KeyEvent.DOM_VK_RETURN || event.keyCode === KeyEvent.DOM_VK_ESCAPE) {  // Enter/Return key or Esc key
                    event.stopPropagation();
                    event.preventDefault();
                    
                    var query = $searchField.val();
                    
                    if (event.keyCode === KeyEvent.DOM_VK_ESCAPE) {
                        query = null;
                    }
                    
                    that._close(query);
                }
            })
            .bind("input", function (event) {
                // Check the query expression on every input event. This way the user is alerted
                // to any RegEx syntax errors immediately.
                _getQueryRegExp($searchField.val());
            })
            .blur(function () {
                that._close(null);
            })
            .focus();
        
        return this.result.promise();
    };
    
    
    function _hideSearchResults() {
        if (searchResultsPanel.isVisible()) {
            searchResultsPanel.hide();
        }
    }
    
    
    /**
     * @private
     * Searches throught the contents an returns an array of matches
     * @param {string} contents
     * @param {RegExp} queryExpr
     * @return {Array.<{start: {line:number,ch:number}, end: {line:number,ch:number}, line: string}>}
     */
    function _getSearchMatches(contents, queryExpr) {
        // Quick exit if not found
        if (contents.search(queryExpr) === -1) {
            return null;
        }
        
        var trimmedContents = contents;
        var startPos = 0;
        var matchStart;
        var matches = [];
        
        var match;
        var lines = StringUtils.getLines(contents);
        while ((match = queryExpr.exec(contents)) !== null) {
            var lineNum     = StringUtils.offsetToLineNum(lines, match.index);
            var line        = lines[lineNum];
            var ch          = match.index - contents.lastIndexOf("\n", match.index) - 1;  // 0-based index
            var matchLength = match[0].length;
            
            // Don't store more than 200 chars per line
            line = line.substr(0, Math.min(200, line.length));
            
            matches.push({
                start: {line: lineNum, ch: ch},
                end:   {line: lineNum, ch: ch + matchLength},
                line:  line
            });

            // We have the max hits in just this 1 file. Stop searching this file.
            // This fixed issue #1829 where code hangs on too many hits.
            if (matches.length >= FIND_IN_FILE_MAX) {
                queryExpr.lastIndex = 0;
                maxHitsFoundInFile = true;
                break;
            }
        }

        return matches;
    }
    
    /**
     * @private
     * Searches and stores the match results for the given file, if there are matches
     * @param {string} fullPath
     * @param {string} contents
     * @param {RegExp} queryExpr
     */
    function _addSearchMatches(fullPath, contents, queryExpr) {
        var matches = _getSearchMatches(contents, queryExpr);
        
        if (matches && matches.length) {
            searchResults[fullPath] = {
                matches:   matches,
                collapsed: false
            };
        }
    }
    
    
    /**
     * @private
     * Shows the results in a table and adds the necesary event listeners
     */
    function _showSearchResults() {
        if (!$.isEmptyObject(searchResults)) {
            
            // Count the total number of matches
            var numFiles = 0, numMatches = 0;
            CollectionUtils.forEach(searchResults, function (item) {
                numFiles++;
                numMatches += item.matches.length;
            });
            
            // No more pages to show
            if (currentStart > numMatches || currentStart < 0) {
                return;
            }
            
            // Show result summary in header
            var numMatchesStr = "";
            if (maxHitsFoundInFile) {
                numMatchesStr = Strings.FIND_IN_FILES_MORE_THAN;
            }
            numMatchesStr += String(numMatches);

            // This text contains some formatting, so all the strings are assumed to be already escaped
            var summary = StringUtils.format(
                Strings.FIND_IN_FILES_TITLE,
                numMatchesStr,
                (numMatches > 1) ? Strings.FIND_IN_FILES_MATCHES : Strings.FIND_IN_FILES_MATCH,
                numFiles,
                (numFiles > 1 ? Strings.FIND_IN_FILES_FILES : Strings.FIND_IN_FILES_FILE),
                StringUtils.htmlEscape(currentQuery),
                currentScope ? _labelForScope(currentScope) : ""
            );
            
            // The last result index displayed
            var last = currentStart + RESULTS_PER_PAGE > numMatches ? numMatches : currentStart + RESULTS_PER_PAGE;
            
            // Insert the search summary
            $searchSummary
                .html(summary +
                     (numMatches > RESULTS_PER_PAGE ? StringUtils.format(Strings.FIND_IN_FILES_PAGING, currentStart + 1, last) : "") +
                     (currentStart > 0 ? Strings.FIND_IN_FILES_LESS : "") +
                     (last < numMatches ? Strings.FIND_IN_FILES_MORE : ""))
                .prepend("&nbsp;"); // putting a normal space before the "-" is not enough
            
            // Create the results template search list
            var searchList = [];
            var resultsDisplayed = 0, i;
            var searchItems, match;
            
            CollectionUtils.some(searchResults, function (item, fullPath) {
                // Skip the items that will not fit in the results page
                if (resultsDisplayed + item.matches.length < currentStart) {
                    resultsDisplayed += item.matches.length;
                    i = -1;
                
                // Only the first matches will be displayed filling the remaining space of the table 
                } else if (resultsDisplayed < currentStart) {
                    i = currentStart - resultsDisplayed;
                    resultsDisplayed = currentStart;
                    
                // All the matches can be displayed
                } else if (resultsDisplayed < last) {
                    i = 0;
                
                // We can't display more items by now. Break the loop
                } else {
                    return true;
                }
                
                if (i >= 0 && i < item.matches.length) {
                    // Add a row for each match in the file
                    searchItems = [];
                    while (i < item.matches.length && resultsDisplayed < last) {
                        match = item.matches[i];
                        searchItems.push({
                            file:      searchList.length,
                            item:      i,
                            line:      StringUtils.format(Strings.FIND_IN_FILES_LINE, (match.start.line + 1)),
                            pre:       match.line.substr(0, match.start.ch),
                            highlight: match.line.substring(match.start.ch, match.end.ch),
                            post:      match.line.substr(match.end.ch),
                            start:     match.start,
                            end:       match.end
                        });
                        resultsDisplayed++;
                        i++;
                    }
                                        
                    // Add a row for each file
                    var displayFileName = StringUtils.format(
                        Strings.FIND_IN_FILES_FILE_PATH,
                        StringUtils.breakableUrl(fullPath)
                    );

                    searchList.push({
                        file:     searchList.length,
                        filename: displayFileName,
                        fullPath: fullPath,
                        items:    searchItems
                    });
                }
            });
            
            // Insert the search results
            $searchContent
                .empty()
                .append(Mustache.render(searchResultsTemplate, {searchList: searchList}))
                .scrollTop(0);  // otherwise scroll pos from previous contents is remembered
            
            $searchResults.find(".close")
                .one("click", function () {
                    _hideSearchResults();
                });
            
            // The link to go the previous page
            $searchResults.find(".find-less")
                .one("click", function () {
                    currentStart -= RESULTS_PER_PAGE;
                    _showSearchResults();
                });
            
            // The link to go to the next page
            $searchResults.find(".find-more")
                .one("click", function () {
                    currentStart += RESULTS_PER_PAGE;
                    _showSearchResults();
                });
            
            // Add the click event listener directly on the table parent
            $searchContent
                .off(".searchList")  // Remove the old events
                .on("click.searchList", function (e) {
                    var $row = $(e.target).closest("tr");
                    
                    if ($row.length) {
                        if ($selectedRow) {
                            $selectedRow.removeClass("selected");
                        }
                        $row.addClass("selected");
                        $selectedRow = $row;
                        
                        var searchItem = searchList[$row.data("file")];
                        var fullPath   = searchItem.fullPath;
                        
                        // This is a file title row, expand/collapse on click
                        if ($row.hasClass("file-section")) {
                            // Clicking the file section header collapses/expands result rows for that file
                            $row.nextUntil(".file-section").toggle();
                            
                            var $triangle = $(".disclosure-triangle", $row);
                            $triangle.toggleClass("expanded").toggleClass("collapsed");
                            
                            searchResults[fullPath].collapsed = !searchResults[fullPath].collapsed;
                        
                        // This is a file row, show the result on click
                        } else {
                            // Grab the required item data
                            var item = searchItem.items[$row.data("item")];
                            
                            CommandManager.execute(Commands.FILE_OPEN, {fullPath: fullPath})
                                .done(function (doc) {
                                    // Opened document is now the current main editor
                                    EditorManager.getCurrentFullEditor().setSelection(item.start, item.end, true);
                                });
                        }
                    }
                })
                // Add the file to the working set on double click
                .on("dblclick.searchList", function (e) {
                    var $row = $(e.target).closest("tr");
                    if ($row.length && !$row.hasClass("file-section")) {
                        // Grab the required item data
                        var item = searchList[$row.data("file")];
                        
                        FileViewController.addToWorkingSetAndSelect(item.fullPath);
                    }
                })
                // Restore the collapsed files
                .find(".file-section").each(function () {
                    var fullPath = searchList[$(this).data("file")].fullPath;
                    
                    if (searchResults[fullPath].collapsed) {
                        searchResults[fullPath].collapsed = false;
                        $(this).trigger("click");
                    }
                });
            
            if ($selectedRow) {
                $selectedRow.removeClass("selected");
                $selectedRow = null;
            }
            searchResultsPanel.show();
        
        } else {
            _hideSearchResults();
        }
    }
    
    /**
     * @param {!FileInfo} fileInfo File in question
     * @param {?Entry} scope Search scope, or null if whole project
     * @return {boolean}
     */
    function inScope(fileInfo, scope) {
        if (scope) {
            if (scope.isDirectory) {
                // Dirs always have trailing slash, so we don't have to worry about being
                // a substring of another dir name
                return fileInfo.fullPath.indexOf(scope.fullPath) === 0;
            } else {
                return fileInfo.fullPath === scope.fullPath;
            }
        }
        return true;
    }
    
    /**
     * Displays a non-modal embedded dialog above the code mirror editor that allows the user to do
     * a find operation across all files in the project.
     * @param {?Entry} scope Project file/subfolder to search within; else searches whole project.
     */
    function doFindInFiles(scope) {
        var dialog = new FindInFilesDialog();
        
        // Default to searching for the current selection
        var currentEditor = EditorManager.getActiveEditor();
        var initialString = currentEditor && currentEditor.getSelectedText();

        searchResults      = {};
        currentQuery       = "";
        currentScope       = scope;
        maxHitsFoundInFile = false;
                            
        dialog.showDialog(initialString, scope)
            .done(function (query) {
                if (query) {
                    currentQuery = query;
                    var queryExpr = _getQueryRegExp(query);
                    if (!queryExpr) {
                        return;
                    }
                    StatusBar.showBusyIndicator(true);
                    FileIndexManager.getFileInfoList("all")
                        .done(function (fileListResult) {
                            Async.doInParallel(fileListResult, function (fileInfo) {
                                var result = new $.Deferred();
                                
                                if (!inScope(fileInfo, scope)) {
                                    result.resolve();
                                } else {
                                    // Search one file
                                    DocumentManager.getDocumentForPath(fileInfo.fullPath)
                                        .done(function (doc) {
                                            _addSearchMatches(fileInfo.fullPath, doc.getText(), queryExpr);
                                            result.resolve();
                                        })
                                        .fail(function (error) {
                                            // Error reading this file. This is most likely because the file isn't a text file.
                                            // Resolve here so we move on to the next file.
                                            result.resolve();
                                        });
                                }
                                return result.promise();
                            })
                                .done(function () {
                                    // Done searching all files: show results
                                    _showSearchResults();
                                    StatusBar.hideBusyIndicator();
                                })
                                .fail(function () {
                                    console.log("find in files failed.");
                                    StatusBar.hideBusyIndicator();
                                });
                        });
                }
            });
    }
    
    /** Search within the file/subtree defined by the sidebar selection */
    function doFindInSubtree() {
        var selectedEntry = ProjectManager.getSelectedItem();
        doFindInFiles(selectedEntry);
    }
    
    
    /**
     * @private
     * Shows the search results and tryes to restore the previous scroll and selection
     */
    function _restoreSearchResults() {
        var scrollTop = $searchContent.scrollTop();
        var index     = $selectedRow ? $selectedRow.index() : null;
        
        _showSearchResults();
        
        $searchContent.scrollTop(scrollTop);
        if ($selectedRow) {
            $selectedRow = $searchContent.find("tr:eq(" + index + ")");
            $selectedRow.addClass("selected");
        }
    }
    
    /**
     * @private
     * Moves the search results from the previous path to the new one and updates the results list, if required
     * @param {$.Event} event
     * @param {string} oldName
     * @param {string} newName
     */
    function _fileNameChangeHandler(event, oldName, newName) {
        var resultsChanged = false;
        
        if (searchResultsPanel.isVisible()) {
            // Update the search results
            CollectionUtils.forEach(searchResults, function (item, fullPath) {
                if (fullPath.match(oldName)) {
                    searchResults[fullPath.replace(oldName, newName)] = item;
                    delete searchResults[fullPath];
                    resultsChanged = true;
                }
            });
            
            // Restore the reesults if needed
            if (resultsChanged) {
                _restoreSearchResults();
            }
        }
    }
    
    /**
     * @private
     * Deletes the results from the deleted file and updates the results list, if required
     * @param {$.Event} event
     * @param {string} path
     */
    function _pathDeletedHandler(event, path) {
        var resultsChanged = false;
        
        if (searchResultsPanel.isVisible()) {
            // Update the search results
            CollectionUtils.forEach(searchResults, function (item, fullPath) {
                if (FileUtils.isAffectedWhenRenaming(fullPath, path)) {
                    delete searchResults[fullPath];
                    resultsChanged = true;
                }
            });
            
            // Restore the reesults if needed
            if (resultsChanged) {
                _restoreSearchResults();
            }
        }
    }
    
    
    // Initialize items dependent on HTML DOM
    AppInit.htmlReady(function () {
        var panelHtml = Mustache.render(searchPanelTemplate, Strings);
        searchResultsPanel = PanelManager.createBottomPanel("find-in-files.results", $(panelHtml));
        
        $searchResults = $("#search-results");
        $searchSummary = $("#search-result-summary");
        $searchContent = $("#search-results .table-container");
    });
    
    // Initialize: register listeners
    $(DocumentManager).on("fileNameChange", _fileNameChangeHandler);
    $(DocumentManager).on("pathDeleted", _pathDeletedHandler);
    $(ProjectManager).on("beforeProjectClose", _hideSearchResults);
    
    // Initialize: command handlers
    CommandManager.register(Strings.CMD_FIND_IN_FILES,   Commands.EDIT_FIND_IN_FILES,   doFindInFiles);
    CommandManager.register(Strings.CMD_FIND_IN_SUBTREE, Commands.EDIT_FIND_IN_SUBTREE, doFindInSubtree);
});
