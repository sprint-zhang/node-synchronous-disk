/**
 * 同步文件夹api，用于客户端同步向上
 * 
 * code by chunyuan.zhang@macrowing.com
 * 
 * time 2021/3-2021/5
 * 
 * 
 *  **/

const chokidar = require('chokidar');
const { ipcMain, app, dialog } = require('electron')
let nedb = require('nedb');
import path from 'path';
import fs from 'fs';
import md5 from 'md5';

const fileChangeState = {
    UPDATE: 'update',//文件更新
    ADD: 'add',//文件新增
}

const synsMsgType = {
    ADD_SYNS: 'add_syns',//新增同步记录
    DEL_SYNS: 'del_syns',//新增同步记录
    START_SYNS: 'start_syns',//开始某一条记录
    STOP_SYNS: 'stop_syns'//开始某一条记录
}




class WatchSystem {
    constructor(synsItem, watchSystemListener) {
        this.watcher = null
        this.ready = false
        this.filepath = synsItem.localPath
        this.synsItem = synsItem
        this.readFiles = []
        this.watchSystemListener = watchSystemListener
    }

    readySuccess = () => {
        let _self = this;
        return new Promise((resolve, reject) => {
            if (!_self.watcher) {
                _self.watcher = chokidar.watch(_self.filepath)
            }
            _self.watcher
                .on('add', _self.addFileListener)
                .on('addDir', _self.addDirecotryListener)
                .on('change', _self.fileChangeListener)
                .on('unlink', _self.fileRemovedListener)
                .on('unlinkDir', _self.directoryRemovedListener)
                .on('error', function (error) {
                    reject(error)
                    console.info('发生了错误：', error);
                })
                .on('ready', function () {
                    console.info('准备监听');

                    let localFile = _self.watcher.getWatched();
                    let fileItem = []
                    for (let item in localFile) {
                        fileItem = localFile[item]
                        if (fileItem.length > 0) {
                            _self.arrGetDeep(fileItem, item)
                        }
                    }
                    resolve(_self.readFiles)
                    _self.ready = true
                })
        })
    }

    arrGetDeep = (arr, upPath) => {
        let self = this;
        let folderPath = ''
        arr.forEach((item) => {
            folderPath = path.resolve(upPath, item);
            self.readFiles.push({
                folderPath: upPath,
                filePath: folderPath
            })
        })
    }
    addFileListener = (path) => {
        if (this.ready) {
            console.log('文件', path, 'has been added')
            this.watchSystemListener({
                state: fileChangeState.ADD,
                sourceKey: this.synsItem.key,
                webPathFolderId: this.synsItem.webPathFolderId,
                netFolderName: this.synsItem.webPath,
                fullPath: path.replace(this.filepath, ''),
                path: path
            })
        }
    }
    addDirecotryListener = (path_) => {
        if (this.ready) {

            console.log('目录', path_, 'has been added')
        }
    }
    fileChangeListener = (path) => {
        console.log('文件', path, '已经修改')
        this.watchSystemListener({
            state: fileChangeState.UPDATE,
            sourceKey: this.synsItem.key,
            webPathFolderId: this.synsItem.webPathFolderId,
            netFolderName: this.synsItem.webPath,
            fullPath: path.replace(this.filepath, ''),
            path: path
        })
    }
    fileRemovedListener = (path_) => {
        console.log('文件', path_, '被删除了')
    }
    directoryRemovedListener = (path_) => {
        console.info('目录', path_, '被删除了')
    }
}


export default class Synsfile {
    /**
     * @Application 当前程序树
     *  **/
    constructor(Application) {
        this.synsList = [];
        this.localfile = new Map();
        this.application = Application;
        let self = this;
        let USER_DATA_DIR = app.getPath('userData');
        this.localfiledb = new nedb({
            filename: path.resolve(USER_DATA_DIR, 'localfile.db'),
        });
        this.synslistdb = new nedb({
            filename: path.resolve(USER_DATA_DIR, 'synslistdb.db'),
        });

        self.loadDatabase(() => {
            self.checkWatch();
        });

        // 监听渲染进程得消息
        ipcMain.on('synsMessage', (event, arg) => {
            switch (arg.msgType) {

                case synsMsgType.ADD_SYNS:
                    self.addSyns(arg.data, event);
                    break;
                case synsMsgType.DEL_SYNS:
                    self.delSyns(arg.data, event);
                    break;
                case synsMsgType.START_SYNS:
                    self.startSyns(arg.data, event);
                    break;
                case synsMsgType.STOP_SYNS:
                    self.stopSyns(arg.data, event);
                    break;
            }
        });

    }


    /**
     * 新增同步记录，插库并同步渲染界面
     * **/
    addSyns = (synsData, event) => {
        let _self = this;
        let newSynsData = {
            ...synsData,
            userKey: _self.application.userKey,
            userId: _self.application.userId
        }
        _self.synslistdb.insert(newSynsData, (err, data) => {
            // 同步渲染进程记录更新
            event.sender.send('synsUpdateMessage');
            _self.loadDatabase(() => {
                _self.addWatch(newSynsData)
            });
        })
    }

    stopSyns = (synsData, event) => {
        let _self = this;

        _self.synslistdb.update(
            {
                key: synsData.key,
            },
            {
                $set: {
                    status: 'stop'
                }
            }, { multi: true },
            (err, data) => {
                _self.closeWatch(synsData.key, event)
            }
        )
    }

    startSyns = (synsData, event) => {
        let _self = this;
        _self.synslistdb.update(
            {
                key: synsData.key,
            },
            {
                $set: {
                    status: 'synsing'
                }
            }, { multi: true },
            (err, data) => {
                event.sender.send('synsUpdateMessage');
                _self.loadDatabase(() => {
                    _self.addWatch(synsData)
                });
            }
        )
    }

    /**
      * 删除同步记录，删缓存并同步渲染界面
      * **/
    delSyns = (synsData, event) => {
        let _self = this;
        _self.synslistdb.remove({ key: synsData.key }, {}, (err, data) => {
            _self.localfiledb.remove({ resoureKey: synsData.key }, { multi: true }, function (err, numRemoved) {
                console.log('del', numRemoved)
            });
            _self.closeWatch(synsData.key, event)
        })
    }



    upLoadFile = (data) => {
        if (this.application.windows && this.application.windows.mainWindow) {
            this.application.windows.mainWindow.send('synsUpload', data);
            console.log('上传文件咯')
        }
    }

    /**
     * 加载缓存  
     * @callback  fn
     * **/
    loadDatabase = (callback) => {
        let self = this;
        self.localfiledb.loadDatabase((err) => {
            self.synslistdb.loadDatabase((err) => {
                callback()
            })
        });
    }

    //  检查记录 添加watcher
    checkWatch = () => {
        let _self = this;
        this.watch = new Map();
        _self.getSynslistdb(() => {
            _self.synsList.forEach((item) => {
                if (item.status == 'synsing') {
                    _self.addWatch(item)
                }
            })
        })
    }


    /**
     * 系统监听返回函数
     * @changeState 文件改变的状态值  {}
     * **/
    watchSystemListener = (changeState = {}) => {
        let _self = this;
        if (_self.application.windows && _self.application.windows.mainWindow) {
            if (changeState.fullPath.indexOf('~') > -1) {
                return
            }

            fs.stat(changeState.path, (err, stats) => {
                if (err) {
                    return
                }
                let fileData = {
                    localPath: changeState.path,
                    resoureKey: changeState.sourceKey,
                    editTime: stats.mtimeMs,
                    netFolderId: changeState.webPathFolderId,
                    netFolderName: changeState.netFolderName,
                    fullPath: changeState.fullPath
                }
                _self.insertUpload({
                    status: changeState.state,
                    data: fileData
                })
            })
        }
    }

    /**
     * 添加监听
    * @synsItem 当前同步记录项 {}
    *  **/
    addWatch = (synsItem) => {
        let self = this;
        let watchSystem = new WatchSystem(synsItem, this.watchSystemListener)
        self.getLocalfiledb({}, () => {
            watchSystem.readySuccess().then((files) => {

                self.watch.set(synsItem.key, {
                    ...synsItem,
                    watcher: watchSystem.watcher
                })

                self.checkLocalFile(files, synsItem)
            })
        })
    }

    /**
     * 检测文件并监听插入
     * @files  文件 {}
     * @synsItem  同步记录 {}
     * **/
    checkLocalFile = (files, synsItem) => {
        let _self = this;
        let _length = _self.localfile.size;
        let _allLocalFile = files;
        let nowReadFolder = new Map();
        let nowLocalFileOnUser = new Map();
        let localFilter = [..._self.localfile.values()].filter((item) => item.resoureKey == synsItem.key);
        localFilter.forEach((item) => {
            nowLocalFileOnUser.set(item.localPath, item);
        });

        _self.getNowFile(_allLocalFile, nowReadFolder, synsItem).then(() => {


            console.log('_allLocalFile')
            let nowReadFolderArr = [...nowReadFolder.values()].filter((item) => item.isFile === true)
            if (nowReadFolderArr.length > 10000) {
                _self.application.windows.mainWindow.send('synsUpload', nowReadFolderArr);
                return;
            }

            if (_length > 0) {

                console.log('nowReadFolderArr')
                // 交集差异
                let diffUpdate = [];

                // 当前文件得交集
                let intersection = nowReadFolderArr.filter(x => localFilter.some(y => y.localPath === x.localPath));

                let reader = null;
                let local = null;
                diffUpdate = intersection.filter((item) => {
                    reader = nowReadFolder.get(item.localPath);
                    local = nowLocalFileOnUser.get(item.localPath);

                    console.log(reader.editTime != local.editTime)
                    return reader.editTime != local.editTime
                })

                // 缓存独有文件
                let diff1 = localFilter.filter(x => nowReadFolderArr.every(y => y.localPath !== x.localPath))

                //当前最新文件独有文件
                let diff2 = nowReadFolderArr.filter(x => localFilter.every(y => y.localPath !== x.localPath))


                if (diffUpdate.length > 0) {
                    if (_self.application.windows && _self.application.windows.mainWindow) _self.diffFileUpdateUpLoad(diffUpdate)
                }

                if (diff2.length > 0) {
                    if (_self.application.windows && _self.application.windows.mainWindow) _self.diffFileInsertUpLoad(diff2)
                }

                if (diff1.length > 0) {
                    diff1.forEach((item) => {
                        _self.localfiledb.remove({ localPath: item.localPath })
                    })
                }
            } else {
                if (nowReadFolderArr.length > 0) {
                    if (_self.application.windows && _self.application.windows.mainWindow) _self.diffFileInsertUpLoad(nowReadFolderArr)
                }
            }
        }).catch((e) => {
            console.log(e)

        })
    }


    /**
     * 获取当前最新文件
     * @_allLocalFile 所有本地文件   {}
     * @nowReadFolder 当前读取文件   {}
     * @synsItem 所属同步记录  {}
     * **/
    getNowFile = (_allLocalFile, nowReadFolder, synsItem) => {
        let fileData = {};

        return new Promise((resolve, reject) => {
            _allLocalFile.forEach((item, i) => {
                let filePath = item.filePath;
                try {
                    fs.stat(filePath, (err, stats) => {
                        if (err) {
                            // reject(err)
                            console.log(item, '读取错误')
                        }
                        let fullPath = filePath.replace(synsItem.localPath, '');
                        fileData = {
                            localPath: filePath,
                            isFile: stats.isFile(),
                            resoureKey: synsItem.key,
                            editTime: stats.mtimeMs,
                            netFolderId: synsItem.webPathFolderId,
                            netFolderName: synsItem.webPath,
                            fullPath: fullPath
                        }
                        nowReadFolder.set(filePath, fileData)
                        if (nowReadFolder.size == _allLocalFile.length) {
                            resolve()
                        }

                    })
                } catch (e) {
                    reject(e)
                }
            })
        });
    }

    readNowFile = () => {

    }

    /**
     * 差异更新上传   
     *  @nowReadFolderArr []
     * **/
    diffFileUpdateUpLoad = (nowReadFolderArr) => {
        let _self = this;
        nowReadFolderArr.forEach((item) => {
            _self.localfiledb.update({
                localPath: item.localPath,
                resoureKey: item.resoureKey
            },
                { $set: { editTime: item.editTime } }, {},
                (err, numReplaced) => {
                })
        })

        this.upLoadFile(nowReadFolderArr)
    }

    /**
     * 差异新增上传
     * 
     * **/
    diffFileInsertUpLoad = (nowReadFolderArr) => {

        let self = this;
        if (nowReadFolderArr.length > 10000) {
            
            if (self.application.windows && self.application.windows.mainWindow) self.application.windows.mainWindow.send('synsUpload', nowReadFolderArr);
        } else {

            self.localfiledb.insert(nowReadFolderArr, (err, newdoc) => {


                debugger
                console.log(newdoc)
                self.upLoadFile(nowReadFolderArr)
            })

        }
    }

    /**np
     * 单个新增更新
     * @file  {}
     * **/
    insertUpload = (file) => {
        let self = this;
        switch (file.status) {
            case fileChangeState.UPDATE:
                this.localfiledb.update({
                    localPath: file.data.localPath,
                    resoureKey: file.data.resoureKey
                },
                    { $set: { editTime: file.data.editTime } }, {},
                    () => {
                        self.upLoadFile(file.data)
                        console.log('更新文件成功\n', file.data.localPath)
                    })
                break;

            case fileChangeState.ADD:
                self.localfiledb.insert(file.data, () => {
                    self.upLoadFile(file.data)
                    console.log('添加文件成功文件成功\n', file.data.localPath)
                })
                break;

        }
    }

    /**
    * 关闭监听器
    * @key 表key
    * @event  消息事件
    *  
    * **/
    closeWatch = (key, event) => {

        let _self = this;
        let wathcer = _self.watch.get(key);
        if (wathcer && wathcer.watcher) {
            if (wathcer.watcher.closed) {
                event.sender.send('synsUpdateMessage');
                _self.watch.delete(key);
            } else {
                wathcer.watcher.close()
                // 同步渲染进程记录更新
                event.sender.send('synsUpdateMessage');
                _self.watch.delete(key);
                console.log('关闭监听')
            }
        } else {
            event.sender.send('synsUpdateMessage');
        }
    }



    /**
     * 清除所有监听
     * 
     * **/
    closeAllWathch = () => {
        [...this.watch.values()].forEach((item) => {
            item.watcher.close()
        });

        this.synsList = [];
        this.localfile = new Map();
    }


    /**
     * 获取表同步记录
     * @callback
     * **/
    getSynslistdb = (callback) => {
        let _self = this;
        _self.synslistdb.find({
            userKey: _self.application.userKey
        }, function (err, docs) {
            if (err) {
                console.log(err)
                return
            }
            if (docs.length > 0) {
                _self.synsList = docs
                callback()
                console.log(docs)
            }
        });
    }

    /**
    * 获取表同步记录
    * @filter   表筛选条件   
    * **/
    getLocalfiledb = (filter = {}, callback) => {
        let _self = this;
        _self.localfiledb.find(filter, function (err, docs) {
            if (err) {

                console.log('缓存文件获取错误了')
                return
            }
            docs.forEach((item) => {
                _self.localfile.set(item.localPath, item)
            })
            callback()
        });
    }


    /**
      * 删除表内容
      * @db   库
      *    
      * **/
    delDb = (db, filter = {}, callback) => {
        // 删除所有记录
        db.remove(filter, { multi: true }, function (err, numRemoved) {
            callback()
        });
    }
}



//未来抽象数据库操作类
// static class DbCtrol {

//     init = () => {
//         this.localfiledb = new nedb({
//             filename: path.resolve(USER_DATA_DIR, 'localfile.db'),
//         });
//         this.synslistdb = new nedb({
//             filename: path.resolve(USER_DATA_DIR, 'synslistdb.db'),
//         });
//     }
// }


// function startWatch(path) {
//     chokidar.watch(path).on('all', (event, path) => {
//         console.log(event, path);
//     });

//     ipcMain.on('asynchronous-message', (event, arg) => {
//         console.log(arg) // prints "ping"
//         event.reply('asynchronous-reply', 'pong')
//     })

// }

// function stopWatch(path) {
//     chokidar.watch(path).on('all', (event, path) => {
//         console.log(event, path);
//     });
// }





