const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const { logger } = require('./logger');

/**
 * Browse /proc in order to find the specific pid
 * @param {number} pid 
 * @returns {*} process stats if any
 */
function existsInProc(pid) {
    try {
        return fs.statSync(`/proc/${pid}`)
    } catch (e) {
        logger('proc', `pid ${pid} not found in procfs`)
    }
}

/*
function retriveStdoutFromProcFd(pid) {
    if (existsInProc(pid)) {
        const unixSocket = fs.readlinkSync(`/proc/${pid}/fd/1`).replace('socket:[', '127.0.0.1:').replace(']', '')
        if (unixSocket) {
            console.log(unixSocket)
            logger('proc', `found pending job on pid: ${pid} attached to UNIX socket: ${unixSocket}`)
            return net.createConnection(unixSocket)
        }
    }
}
*/

/**
 * Kills a process with a sys-call
 * @param {number} pid the killed process pid
 */
async function killProcess(pid) {
    const res = spawn('kill', [pid])
    res.on('exit', () => {
        logger('proc', `Successfully killed yt-dlp process, pid: ${pid}`)
    })
}

module.exports = {
    existsInProc: existsInProc,
    //retriveStdoutFromProcFd: retriveStdoutFromProcFd,
    killProcess: killProcess,
}