import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { QRCodeSVG } from 'qrcode.react';

type FileData = {
  id: string;
  name: string;
  size: number;
  type: string;
  file?: File;
  received?: number;
  chunks?: Uint8Array[];
  status?: 'pending' | 'transferring' | 'completed' | 'error';
};

type TransferStatus = 'idle' | 'waiting' | 'transferring' | 'completed' | 'error';

export default function FileShareApp() {
  const [mode, setMode] = useState<'send' | 'receive'>('send');
  const [sessionCode, setSessionCode] = useState('');
  const [status, setStatus] = useState<{
    message: string;
    type: TransferStatus;
    progress?: number;
  }>({ message: 'Select files to begin', type: 'idle' });
  const [files, setFiles] = useState<FileData[]>([]);
  const [transferProgress, setTransferProgress] = useState<Record<string, {
    bytes: number;
    total: number;
    speed: string;
  }>>({});
  const [showQR, setShowQR] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [peerConnected, setPeerConnected] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const speedRef = useRef<{ lastTime: number; lastBytes: number }>({ lastTime: 0, lastBytes: 0 });
  const CHUNK_SIZE = 64 * 1024; // 64KB chunks
  const MAX_FILE_SIZE = 1024 * 1024 * 1024 * 2; // 2GB

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlMode = params.get('mode');
    const urlCode = params.get('code');

    if (urlMode === 'receive' && urlCode) {
      setMode('receive');
      setSessionCode(urlCode);
    }

    socketRef.current = io({
      path: '/api/socket',
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      transports: ['websocket'],
    });

    const socket = socketRef.current;

    socket.on('connect', () => {
      console.log('✅ Connected to server');
      setStatus({ message: 'Connected to server', type: 'idle' });
    });

    socket.on('session-created', (code: string) => {
      setSessionCode(code);
      setStatus({ message: 'Session created. Share the code with receiver', type: 'waiting' });

      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('mode', 'send');
      newUrl.searchParams.set('code', code);
      window.history.pushState({}, '', newUrl.toString());
    });

    socket.on('receiver-joined', () => {
      setStatus({ message: 'Receiver connected. Ready to transfer...', type: 'waiting' });
      setPeerConnected(true);
    });

    socket.on('file-meta', (meta: { name: string, size: number, type: string }) => {
      const fileId = uuidv4();
      setStatus({
        message: `Receiving ${meta.name} (${formatFileSize(meta.size)})...`,
        type: 'transferring',
      });
      
      setFiles(prev => [...prev, {
        ...meta,
        id: fileId,
        received: 0,
        chunks: [],
        status: 'transferring'
      }]);
    });

    socket.on('file-chunk', (chunk: ArrayBuffer, progress: number) => {
      const now = Date.now();
      const lastFile = files[files.length - 1];
      const lastProgress = lastFile ? transferProgress[lastFile.id]?.bytes || 0 : 0;
      const bytesReceived = chunk.byteLength;
      const speed = calculateSpeed(bytesReceived, speedRef.current.lastTime);
    
      if (lastFile) {
        setTransferProgress(prev => ({
          ...prev,
          [lastFile.id]: {
            bytes: lastProgress + bytesReceived,
            total: lastFile.size || 0,
            speed
          },
        }));
    
        speedRef.current = { lastTime: now, lastBytes: lastProgress + bytesReceived };
    
        setFiles(prev => prev.map(file => {
          if (file.id === lastFile.id) {
            const received = (file.received || 0) + bytesReceived;
            const chunks = [...(file.chunks || []), new Uint8Array(chunk)];
            return { ...file, received, chunks };
          }
          return file;
        }));
      }
    });
    socket.on('transfer-complete', () => {
      setStatus({ message: 'Transfer completed successfully!', type: 'completed' });
      setFiles(prev => prev.map(file => ({
        ...file,
        status: file.status === 'transferring' ? 'completed' : file.status
      })));
    });

    socket.on('session-expired', () => {
      setStatus({ message: 'Session expired. Please start a new transfer.', type: 'error' });
      resetTransfer();
    });

    socket.on('invalid-session', () => {
      setStatus({ message: 'Invalid session code. Please check and try again.', type: 'error' });
    });

    socket.on('error', (error: string) => {
      setStatus({ message: `Error: ${error}`, type: 'error' });
    });

    socket.on('disconnect', () => {
      setStatus({ message: 'Disconnected from server. Reconnecting...', type: 'error' });
      setPeerConnected(false);
    });

    return () => {
      if (socket.connected) {
        socket.disconnect();
      }
    };
  }, []);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const calculateSpeed = (bytes: number, startTime: number): string => {
    const now = Date.now();
    const elapsed = (now - startTime) / 1000;
    if (elapsed <= 0) return '0 KB/s';

    const speed = bytes / elapsed;
    return speed >= 1024 * 1024
      ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s`
      : `${(speed / 1024).toFixed(1)} KB/s`;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement> | React.DragEvent) => {
    let selectedFiles: File[] = [];

    if ('dataTransfer' in e) {
      selectedFiles = Array.from(e.dataTransfer.files);
    } else if (e.target.files) {
      selectedFiles = Array.from(e.target.files);
    }

    if (selectedFiles.length === 0) return;

    const oversizedFiles = selectedFiles.filter(f => f.size > MAX_FILE_SIZE);
    if (oversizedFiles.length > 0) {
      setStatus({
        message: `Error: ${oversizedFiles[0].name} exceeds 2GB limit`,
        type: 'error',
      });
      return;
    }

    const newFiles: FileData[] = selectedFiles.map(file => ({
      id: uuidv4(),
      name: file.name,
      size: file.size,
      type: file.type,
      file,
      received: 0,
      chunks: [],
      status: 'pending' as 'pending'
    }));

    setFiles(prev => [...prev, ...newFiles]);
    setStatus({
      message: `Ready to send ${newFiles.length} file(s)`,
      type: 'idle',
    });
    setIsDragging(false);
  };

  const createSession = () => {
    const code = uuidv4().slice(0, 8).toUpperCase();
    socketRef.current?.emit('create-session', code);
  };

  const sendFiles = async () => {
    if (files.length === 0 || !socketRef.current?.connected) {
      setStatus({
        message: 'No files selected or not connected',
        type: 'error',
      });
      return;
    }

    const file = files[0]; // For simplicity, just send first file
    if (!file.file) return;

    // Update file status
    setFiles(prev => prev.map(f => 
      f.id === file.id ? { ...f, status: 'transferring' } : f
    ));

    // Send file metadata first
    socketRef.current.emit('file-meta', {
      name: file.name,
      size: file.size,
      type: file.type,
    }, sessionCode);

    // Read and send file in chunks
    const fileReader = new FileReader();
    const fileSize = file.size;
    let offset = 0;

    fileReader.onload = (e) => {
      if (!e.target?.result) return;

      const chunk = e.target.result as ArrayBuffer;
      
      socketRef.current?.emit('file-chunk',
        chunk,
        sessionCode,
        (offset / fileSize) * 100
      );

      offset += chunk.byteLength;
      setTransferProgress(prev => ({
        ...prev,
        [file.id]: {
          bytes: offset,
          total: fileSize,
          speed: calculateSpeed(chunk.byteLength, speedRef.current.lastTime)
        },
      }));

      speedRef.current = { lastTime: Date.now(), lastBytes: offset };

      if (offset < fileSize) {
        readNextChunk();
      } else {
        socketRef.current?.emit('transfer-complete', sessionCode);
        setStatus({
          message: 'Transfer completed successfully!',
          type: 'completed',
        });
      }
    };

    const readNextChunk = () => {
      const chunk = file.file!.slice(offset, offset + CHUNK_SIZE);
      fileReader.readAsArrayBuffer(chunk);
    };

    readNextChunk();
  };

  const handleReceive = () => {
    if (!sessionCode || !socketRef.current?.connected) {
      setStatus({
        message: 'Enter a valid session code',
        type: 'error',
      });
      return;
    }

    socketRef.current.emit('join-session', sessionCode);
    setStatus({
      message: 'Connecting to sender...',
      type: 'waiting',
    });
  };

  const downloadFile = (file: FileData) => {
    if (!file.chunks) return;

    const blob = new Blob(file.chunks, { type: file.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const removeFile = (fileId: string) => {
    setFiles(prev => prev.filter(f => f.id !== fileId));
  };

  const resetTransfer = () => {
    setFiles([]);
    setSessionCode('');
    setStatus({ message: 'Select files to begin', type: 'idle' });
    setTransferProgress({});
    setPeerConnected(false);

    const newUrl = new URL(window.location.href);
    newUrl.searchParams.delete('mode');
    newUrl.searchParams.delete('code');
    window.history.pushState({}, '', newUrl.toString());
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const FileIcon = ({ type }: { type?: string }) => {
    const getFileIcon = () => {
      const fileType = type?.split('/')[0] || type?.split('.').pop() || 'default';
      const icons: Record<string, string> = {
        pdf: '📄',
        text: '📄',
        image: '🖼️',
        audio: '🎵',
        video: '🎬',
        application: '📁',
        zip: '🗜️',
        default: '📁',
      };
      return icons[fileType] || icons.default;
    };

    return (
      <span className="text-2xl" title={type}>
        {getFileIcon()}
      </span>
    );
  };

  const StatusIndicator = ({ type }: { type: TransferStatus }) => {
    const colors = {
      idle: 'bg-gray-500',
      waiting: 'bg-yellow-500',
      transferring: 'bg-blue-500',
      completed: 'bg-green-500',
      error: 'bg-red-500',
    };

    return (
      <div className={`h-3 w-3 rounded-full ${colors[type]}`}></div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 text-white p-4">
      <div className="max-w-4xl mx-auto bg-gray-800 rounded-xl shadow-2xl overflow-hidden border border-gray-700">
        {/* Header */}
        <div className="bg-gray-900 p-6 text-center border-b border-gray-700">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
            Quantum Share
          </h1>
          <p className="text-gray-400 mt-2">
            Secure, fast file transfers with end-to-end encryption
          </p>
        </div>

        {/* Main Content */}
        <div className="p-6">
          {/* Mode Toggle */}
          <div className="flex justify-center mb-8">
            <div className="inline-flex rounded-full shadow-sm bg-gray-700 p-1">
              <button
                onClick={() => {
                  setMode('send');
                  resetTransfer();
                }}
                className={`px-6 py-2 rounded-full text-sm font-medium transition-all ${
                  mode === 'send'
                    ? 'bg-blue-600 text-white shadow-lg'
                    : 'text-gray-300 hover:bg-gray-600'
                }`}
              >
                <span className="flex items-center">
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                  Send
                </span>
              </button>
              <button
                onClick={() => {
                  setMode('receive');
                  resetTransfer();
                }}
                className={`px-6 py-2 rounded-full text-sm font-medium transition-all ${
                  mode === 'receive'
                    ? 'bg-green-600 text-white shadow-lg'
                    : 'text-gray-300 hover:bg-gray-600'
                }`}
              >
                <span className="flex items-center">
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  Receive
                </span>
              </button>
            </div>
          </div>

          {/* Send Mode */}
          {mode === 'send' ? (
            <div className="space-y-6">
              {/* File Drop Zone */}
              <div
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                  isDragging
                    ? 'border-blue-500 bg-blue-900/20'
                    : 'border-gray-600 hover:border-blue-400'
                }`}
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={(e) => {
                  e.preventDefault();
                  handleFileSelect(e);
                }}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <div className="flex flex-col items-center justify-center space-y-3">
                  <svg className={`w-14 h-14 ${isDragging ? 'text-blue-400' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <p className={`text-lg font-medium ${isDragging ? 'text-blue-300' : 'text-gray-300'}`}>
                    {isDragging ? 'Drop files here' : 'Click to select or drag and drop'}
                  </p>
                  <p className="text-sm text-gray-500">
                    Max file size: 2GB (encrypted during transfer)
                  </p>
                </div>
              </div>

              {/* Selected Files */}
              {files.length > 0 && (
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <h3 className="font-medium text-gray-300">
                      {files.length} file{files.length > 1 ? 's' : ''} selected
                    </h3>
                    <button
                      onClick={resetTransfer}
                      className="text-sm text-red-400 hover:text-red-300 flex items-center"
                    >
                      <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Clear all
                    </button>
                  </div>

                  <div className="border border-gray-700 rounded-lg overflow-hidden">
                    {files.map(file => (
                      <div key={file.id} className="p-4 bg-gray-700/50 hover:bg-gray-700/70 transition-colors border-b border-gray-700 last:border-b-0">
                        <div className="flex items-center space-x-4">
                          <FileIcon type={file.type} />
                          <div className="flex-1 min-w-0">
                            <div className="flex justify-between">
                              <p className="text-sm font-medium text-gray-100 truncate" title={file.name}>
                                {file.name}
                              </p>
                              <p className="text-xs text-gray-400 ml-2 whitespace-nowrap">
                                {formatFileSize(file.size)}
                              </p>
                            </div>
                            <div className="mt-2">
                              <div className="flex justify-between text-xs text-gray-400 mb-1">
                                <span>
                                  {transferProgress[file.id] ?
                                    `${Math.round((transferProgress[file.id].bytes / file.size) * 100)}%` :
                                    '0%'}
                                </span>
                                <span>
                                  {transferProgress[file.id]?.speed || '0 KB/s'}
                                </span>
                              </div>
                              <div className="w-full bg-gray-800 rounded-full h-1.5">
                                <div
                                  className="bg-gradient-to-r from-blue-500 to-purple-500 h-1.5 rounded-full"
                                  style={{
                                    width: `${transferProgress[file.id] ?
                                      Math.round((transferProgress[file.id].bytes / file.size) * 100) :
                                      0}%`
                                  }}
                                ></div>
                              </div>
                            </div>
                          </div>
                          <button
                            onClick={() => removeFile(file.id)}
                            className="text-gray-400 hover:text-red-400 p-1 transition-colors"
                            title="Remove file"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Transfer Controls */}
                  <div className="pt-2 space-y-3">
                    {!sessionCode ? (
                      <button
                        onClick={createSession}
                        disabled={!files.length}
                        className={`w-full py-3 rounded-lg font-medium transition-all flex items-center justify-center ${
                          files.length
                            ? 'bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white shadow-lg'
                            : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                        }`}
                      >
                        <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        Start Secure Transfer
                      </button>
                    ) : (
                      <>
                        {!peerConnected ? (
                          <div className="text-center py-3 text-yellow-400">
                            Waiting for receiver to connect...
                          </div>
                        ) : (
                          <button
                            onClick={sendFiles}
                            className="w-full py-3 rounded-lg font-medium transition-all flex items-center justify-center bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-500 hover:to-teal-500 text-white shadow-lg"
                          >
                            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                            </svg>
                            Send Files Now
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Session Info */}
              {sessionCode && (
                <div className="mt-6 p-5 bg-gray-900/50 rounded-xl border border-gray-700">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between space-y-4 md:space-y-0">
                    <div>
                      <p className="font-medium text-blue-400">Transfer Session</p>
                      <p className="text-2xl font-mono font-bold text-white">{sessionCode}</p>
                      <p className="text-sm text-gray-400 mt-1">
                        Share this code with the receiver
                      </p>
                    </div>
                    <div className="flex flex-col items-center space-y-3">
                      <button
                        onClick={() => setShowQR(!showQR)}
                        className="px-4 py-2 bg-gray-800 text-white rounded-lg border border-gray-700 hover:bg-gray-700 transition-colors text-sm font-medium flex items-center"
                      >
                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                        </svg>
                        {showQR ? 'Hide QR Code' : 'Show QR Code'}
                      </button>
                      {showQR && (
                        <div className="p-3 bg-white rounded border border-gray-300">
                          <QRCodeSVG
                            value={`${window.location.origin}?mode=receive&code=${sessionCode}`}
                            size={140}
                            level="H"
                            includeMargin={false}
                            bgColor="#1f2937"
                            fgColor="#ffffff"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Receive Mode */
            <div className="space-y-6">
              {/* Session Code Input */}
              <div className="space-y-3">
                <label className="block font-medium text-gray-300">Enter Session Code</label>
                <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
                  <input
                    type="text"
                    value={sessionCode}
                    onChange={(e) => setSessionCode(e.target.value)}
                    className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="Paste the sender's code here"
                  />
                  <button
                    onClick={handleReceive}
                    disabled={!sessionCode}
                    className={`py-3 px-6 rounded-lg font-medium transition-all flex items-center justify-center ${
                      sessionCode
                        ? 'bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-500 hover:to-teal-500 text-white shadow-lg'
                        : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                    }`}
                  >
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                    Connect
                  </button>
                </div>
              </div>

              {/* Incoming Files */}
              {files.length > 0 && (
                <div className="border border-gray-700 rounded-lg overflow-hidden">
                  <div className="p-4 bg-gray-900 border-b border-gray-700">
                    <h3 className="font-medium text-gray-300">
                      Incoming Files • {files.length} file{files.length > 1 ? 's' : ''}
                    </h3>
                  </div>
                  <ul className="divide-y divide-gray-700">
                    {files.map(file => (
                      <li key={file.id} className="p-4 bg-gray-800/50 hover:bg-gray-800/70 transition-colors">
                        <div className="flex items-center space-x-4">
                          <FileIcon type={file.type} />
                          <div className="flex-1 min-w-0">
                            <div className="flex justify-between">
                              <p className="text-sm font-medium text-gray-100 truncate" title={file.name}>
                                {file.name}
                              </p>
                              <p className="text-xs text-gray-400 ml-2 whitespace-nowrap">
                                {formatFileSize(file.received || 0)} / {formatFileSize(file.size)}
                              </p>
                            </div>
                            <div className="mt-2">
                              <div className="flex justify-between text-xs text-gray-400 mb-1">
                                <span>
                                  {Math.round(((file.received || 0) / file.size) * 100)}%
                                </span>
                                <span>
                                  {transferProgress[file.id]?.speed || '0 KB/s'} •
                                  {file.received === file.size ? ' Ready' : ' Receiving...'}
                                </span>
                              </div>
                              <div className="w-full bg-gray-700 rounded-full h-1.5">
                                <div
                                  className="bg-gradient-to-r from-green-500 to-teal-500 h-1.5 rounded-full"
                                  style={{
                                    width: `${Math.round(((file.received || 0) / file.size) * 100)}%`
                                  }}
                                ></div>
                              </div>
                            </div>
                          </div>
                          {file.received === file.size ? (
                            <button
                              onClick={() => downloadFile(file)}
                              className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded-lg text-sm font-medium transition-colors flex items-center"
                            >
                              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                              Save
                            </button>
                          ) : (
                            <div className="h-8 w-8 flex items-center justify-center">
                              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-green-500"></div>
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Status Bar */}
          <div className="mt-6 p-3 bg-gray-900 rounded-lg border border-gray-700">
            <div className="flex items-center space-x-3">
              <StatusIndicator type={status.type} />
              <p className="text-sm font-medium text-gray-300 flex-1">
                {status.message}
              </p>
              {status.type === 'transferring' && transferProgress[files[0]?.id]?.speed && (
                <p className="text-xs bg-gray-800 text-blue-400 px-2 py-1 rounded-full">
                  {transferProgress[files[0]?.id]?.speed}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="bg-gray-900 p-4 text-center text-xs text-gray-500 border-t border-gray-800">
          <p>Files are encrypted with AES-256 during transfer • No files are stored on the server</p>
        </div>
      </div>
    </div>
  );
}