import { spawn } from 'child_process';
import { from, interval } from 'rxjs';
import { map, throttle } from 'rxjs/operators';
import { Socket } from 'socket.io';
import { IPayload } from '../interfaces/IPayload';
import { ISettings } from '../interfaces/ISettings';
import Logger from '../utils/BetterLogger';
import Process from './Process';
import MemoryDB from '../db/memoryDB';

// settings read from settings.json
let settings: ISettings;
let coldRestart = true;
const log = Logger.instance;

const mem_db = new MemoryDB();

try {
    settings = require('../../settings.json');
}
catch (e) {
    new Promise(resolve => setTimeout(resolve, 500))
        .then(() => log.warn('dl', 'settings.json not found, ignore if using Docker'));
}
/**
 * Get download info such as thumbnail, title, resolution and list all formats
 * @param socket 
 * @param url 
 */
export async function getFormatsAndInfo(socket: Socket, url: string) {
    let p = new Process(url, [], settings);
    const formats = await p.getInfo();
    socket.emit('available-formats', formats)
    p = null;
}

/**
 * Invoke a new download.  
 * Called by the websocket messages listener.
 * @param {Socket} socket current connection socket
 * @param {object} payload frontend download payload
 * @returns 
 */
export async function download(socket: Socket, payload: IPayload) {
    if (!payload || payload.url === '' || payload.url === null) {
        socket.emit('progress', { status: 'Done!' });
        return;
    }

    const url = payload.url;
    const params = typeof payload.params !== 'object' ?
        payload.params.split(' ') :
        payload.params;

    let p = new Process(url, params, settings);

    p.start().then(downloader => {
        mem_db.add(downloader)
        displayDownloadInfo(downloader, socket);
        streamProcess(downloader, socket);
    });
}

/**
 * Send via websocket download info "chunk"
 * @param process 
 * @param socket 
 */
function displayDownloadInfo(process: Process, socket: Socket) {
    process.getInfo().then(info => {
        socket.emit('info', {
            pid: process.getPid(),
            info: info
        });
    });
}

/**
 * Stream via websocket download stdoud "chunks"
 * @param process 
 * @param socket 
 */
function streamProcess(process: Process, socket: Socket) {
    const emitAbort = () => {
        socket.emit('progress', {
            status: 'Done!',
            pid: process.getPid(),
        });
    }
    const stdout = process.getStdout()

    stdout.removeAllListeners()

    from(stdout)                            // stdout as observable
        .pipe(
            throttle(() => interval(500)),  // discard events closer than 500ms
            map(stdout => formatter(String(stdout), process.getPid()))
        )
        .subscribe({
            next: (stdout) => socket.emit('progress', stdout),
            complete: () => {
                process.kill().then(() => {
                    emitAbort();
                    mem_db.remove(process);
                });
            },
            error: () => {
                emitAbort();
                mem_db.remove(process);
            }
        });
}

/**
 * Retrieve all downloads.  
 * If the server has just been launched retrieve the ones saved to the database.  
 * If the server is running fetches them from the process pool.
 * @param {Socket} socket current connection socket
 * @returns 
 */
export async function retrieveDownload(socket: Socket) {
    // it's a cold restart: the server has just been started with pending
    // downloads, so fetch them from the database and resume.

    // if (coldRestart) {
    //     coldRestart = false;
    //     let downloads = [];
    //     // sanitize
    //     downloads = [...new Set(downloads.filter(el => el !== undefined))];
    //     log.info('dl', `Cold restart, retrieving ${downloads.length} jobs`)
    //     for (const entry of downloads) {
    //         if (entry) {
    //             await download(socket, entry);
    //         }
    //     }
    //     return;
    // }

    // it's an hot-reload the server it's running and the frontend ask for
    // the pending job: retrieve them from the "in-memory database" (ProcessPool)

    const _poolSize = mem_db.size()
    log.info('dl', `Retrieving ${_poolSize} jobs from pool`)
    socket.emit('pending-jobs', _poolSize)

    const it = mem_db.iterator();

    // resume the jobs
    for (const entry of it) {
        const [, process] = entry
        displayDownloadInfo(process, socket);
        streamProcess(process, socket);
    }
}

/**
 * Abort a specific download if pid is provided, in the other case
 * calls the abortAllDownloads function
 * @see abortAllDownloads
 * @param {Socket} socket currenct connection socket
 * @param {*} args args sent by the frontend. MUST contain the PID.
 * @returns 
 */
export function abortDownload(socket: Socket, args: any) {
    if (!args) {
        abortAllDownloads(socket);
        return;
    }
    const { pid } = args;

    spawn('kill', [pid])
        .on('exit', () => {
            socket.emit('progress', {
                status: 'Aborted',
                process: pid,
            });
            log.warn('dl', `Aborting download ${pid}`);
        });
}

/**
 * Unconditionally kills all yt-dlp process.
 * @param {Socket} socket currenct connection socket
 */
export function abortAllDownloads(socket: Socket) {
    spawn('killall', ['yt-dlp'])
        .on('exit', () => {
            socket.emit('progress', { status: 'Aborted' });
            log.info('dl', 'Aborting downloads');
        });
    mem_db.flush();
}

/**
 * Get pool current size
 */
export function getQueueSize(): number {
    return mem_db.size();
}

/**
 * @private Formats the yt-dlp stdout to a frontend-readable format
 * @param {string} stdout stdout as string
 * @param {number} pid current process id relative to stdout
 * @returns 
 */
const formatter = (stdout: string, pid: number) => {
    const cleanStdout = stdout
        .replace(/\s\s+/g, ' ')
        .split(' ');
    const status = cleanStdout[0].replace(/\[|\]|\r/g, '');
    switch (status) {
        case 'download':
            return {
                status: 'download',
                progress: cleanStdout[1],
                size: cleanStdout[3],
                dlSpeed: cleanStdout[5],
                pid: pid,
            }
        case 'merge':
            return {
                status: 'merging',
                progress: '100',
            }
        default:
            return {
                progress: '0'
            }
    }
}
