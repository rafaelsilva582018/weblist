import { ArrowLeft, CalendarDays, Cast, Maximize, Minimize, Pause, PictureInPicture, Play, RotateCcw, RotateCw, Server, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../api.js';
import FavoriteButton from '../components/FavoriteButton.jsx';
import { useAuth } from '../context/AuthContext.jsx';

let hlsModulePromise;
let mpegtsModulePromise;

function isHlsUrl(url = '') {
  return /\.m3u8(\?|#|$)/i.test(url);
}

function isMpegTs(item) {
  return item?.streamFormat === 'mpegts' || /\.ts(\?|#|$)/i.test(item?.directStreamUrl || item?.streamUrl || '');
}

function sourceSummary(source, index) {
  const parts = [source?.quality, source?.language, source?.codec].filter(Boolean);
  return parts.join(' - ') || source?.label || `Opcao ${index + 1}`;
}

async function loadHlsModule() {
  const module = await (hlsModulePromise ||= import('hls.js'));
  return module.default || module;
}

async function loadMpegtsModule() {
  const module = await (mpegtsModulePromise ||= import('mpegts.js'));
  return module.default || module;
}

const liveStashBufferBytes = 4 * 1024 * 1024;
const liveBackwardBufferSeconds = 10;
const liveStartupBufferSeconds = 10;
const liveStartupMaxWaitMs = 10000;
const liveTargetLatencySeconds = 10;
const liveMaxLatencySeconds = 24;
const liveMinBufferAheadSeconds = 1.5;
const liveStallTimeoutMs = 12000;
const liveRestartCooldownMs = 8000;

function safelyCall(target, method) {
  try {
    target?.[method]?.();
  } catch {
    // Media teardown varies a little between HLS, MPEG-TS and Android WebView.
  }
}

function releaseVideoElement(video) {
  if (!video) return;
  try {
    video.pause();
  } catch {
    // Ignore teardown errors from already released media elements.
  }
  try {
    video.removeAttribute('src');
    video.load();
  } catch {
    // Some WebViews throw while a MediaSource is detaching.
  }
}

function destroyMediaInstance(instance) {
  safelyCall(instance, 'pause');
  safelyCall(instance, 'stopLoad');
  safelyCall(instance, 'unload');
  safelyCall(instance, 'detachMedia');
  safelyCall(instance, 'detachMediaElement');
  safelyCall(instance, 'destroy');
}

export default function PlayerPage() {
  const { type, id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const sourceParam = searchParams.get('source') || '';
  const autoPlayEnabled = searchParams.get('autoplay') !== '0';
  const videoRef = useRef(null);
  const shellRef = useRef(null);
  const mediaPlayerRef = useRef(null);
  const lastSaveRef = useRef(0);
  const autoPlayAttemptedRef = useRef(false);
  const lastLiveTickRef = useRef({ position: 0, updatedAt: Date.now() });
  const lowLiveBufferSinceRef = useRef(0);
  const lastLiveRestartRef = useRef(0);
  const backgroundPausedRef = useRef(false);
  const shouldResumeLiveRef = useRef(false);
  const pendingLivePlayRef = useRef(false);
  const pendingLivePlayStartedAtRef = useRef(0);
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [remotePlaybackState, setRemotePlaybackState] = useState('unsupported');
  const [remotePlaybackAvailable, setRemotePlaybackAvailable] = useState(false);
  const [streamReloadKey, setStreamReloadKey] = useState(0);
  const [guideOpen, setGuideOpen] = useState(false);
  const [liveBuffering, setLiveBuffering] = useState(false);
  const [liveBufferAhead, setLiveBufferAhead] = useState(0);
  const [nextEpisodeBusy, setNextEpisodeBusy] = useState(false);
  const hideTimerRef = useRef(null);
  const isLive = type === 'channel' || item?.streamFormat === 'mpegts';
  const hasGuide = item?.guide?.length > 0;
  const sourceOptions = item?.sources || [];
  const favoriteType = type === 'movie' || type === 'channel' ? type : null;
  const remotePlaybackSupported = remotePlaybackState !== 'unsupported';
  const shouldAutoplayNext = user?.autoplayNext !== false;
  const finishClock = !isLive && isPlaying && duration > current
    ? formatFinishClock(Math.max(0, duration - current))
    : '';

  function getLiveBufferedAhead(video = videoRef.current) {
    if (!video?.buffered?.length) return 0;
    const position = video.currentTime || 0;
    for (let index = 0; index < video.buffered.length; index += 1) {
      const start = video.buffered.start(index);
      const end = video.buffered.end(index);
      if (position >= start - 0.25 && position <= end + 0.25) {
        return Math.max(0, end - position);
      }
    }
    return Math.max(0, video.buffered.end(video.buffered.length - 1) - position);
  }

  async function playMedia(video = videoRef.current) {
    if (!video) return;
    if (isMpegTs(item) && mediaPlayerRef.current?.play) {
      await Promise.resolve(mediaPlayerRef.current.play());
    } else {
      await video.play();
    }
  }

  const saveProgress = useCallback((options = {}) => {
    const opts = options?.currentTarget ? {} : options;
    const video = opts.video || videoRef.current;
    if (!video || !item) return;

    const duration = type === 'channel' ? 0 : Number.isFinite(video.duration) ? video.duration : 0;
    const completed = opts?.completed === true;
    const position = completed && duration
      ? duration
      : type === 'channel' ? Math.max(1, video.currentTime || 0) : video.currentTime || 0;
    apiFetch('/progress', {
      method: 'POST',
      body: {
        type,
        id: Number(id),
        position,
        duration,
        completed
      }
    }).catch(() => {});
  }, [id, item, type]);

  useEffect(() => {
    autoPlayAttemptedRef.current = false;
    pendingLivePlayRef.current = false;
    shouldResumeLiveRef.current = false;
    lowLiveBufferSinceRef.current = 0;
    setLiveBuffering(false);
    setLiveBufferAhead(0);
    setGuideOpen(false);
    setCurrent(0);
    setDuration(0);
    setIsPlaying(false);
    setNextEpisodeBusy(false);
    setItem(null);
    setError('');
    releaseVideoElement(videoRef.current);
    const sourceQuery = sourceParam ? `?source=${encodeURIComponent(sourceParam)}` : '';
    apiFetch(`/play/${type}/${id}${sourceQuery}`)
      .then((data) => setItem(data.item))
      .catch((err) => setError(err.message));
  }, [id, sourceParam, type]);

  useEffect(() => {
    if (!item?.streamUrl || !videoRef.current) return undefined;
    if (Number(item.id) !== Number(id)) return undefined;

    const video = videoRef.current;
    let hls;
    let tsPlayer;
    let mpegtsLib;
    let liveWatchdog;
    let disposed = false;
    mediaPlayerRef.current = null;
    releaseVideoElement(video);
    setError('');

    const latestBufferedEnd = () => {
      if (!video.buffered.length) return 0;
      return video.buffered.end(video.buffered.length - 1);
    };
    const finishPendingLivePlay = () => {
      if (!pendingLivePlayRef.current || disposed || document.hidden) return;
      const bufferedAhead = getLiveBufferedAhead(video);
      setLiveBufferAhead(bufferedAhead);
      const waited = Date.now() - pendingLivePlayStartedAtRef.current;
      if (bufferedAhead < liveStartupBufferSeconds && waited < liveStartupMaxWaitMs) return;

      pendingLivePlayRef.current = false;
      setLiveBuffering(false);
      playMedia(video).catch(() => setError('Clique novamente para iniciar a reproducao'));
    };
    const restartLiveStream = () => {
      if (disposed || document.hidden) return;
      const now = Date.now();
      if (now - lastLiveRestartRef.current < liveRestartCooldownMs) return;
      lastLiveRestartRef.current = now;
      shouldResumeLiveRef.current = !video.paused;
      setError('Reconectando canal ao vivo...');
      setStreamReloadKey((value) => value + 1);
    };
    const keepCloseToLiveEdge = () => {
      const liveEdge = latestBufferedEnd();
      if (!liveEdge || !Number.isFinite(liveEdge)) return;
      const bufferedAhead = liveEdge - (video.currentTime || 0);
      if (bufferedAhead > liveMaxLatencySeconds) {
        video.currentTime = Math.max(0, liveEdge - liveTargetLatencySeconds);
      }
    };

    const restoreProgress = async () => {
      if (type === 'channel') return;
      const data = await apiFetch(`/progress?type=${type}&id=${id}`).catch(() => ({ progress: null }));
      const progress = data.progress;
      if (progress?.position > 10) {
        const duration = Number.isFinite(video.duration) ? video.duration : progress.duration;
        if (!duration || progress.position < duration - 10) {
          video.currentTime = progress.position;
        }
      }
    };

    const clearPlayableError = () => {
      setError('');
    };
    const resumeLiveIfNeeded = () => {
      if (!isMpegTs(item) || !shouldResumeLiveRef.current || document.hidden) return;
      Promise.resolve(mediaPlayerRef.current?.play?.() || video.play())
        .then(() => {
          shouldResumeLiveRef.current = false;
        })
        .catch(() => {});
    };
    const autoPlayIfRequested = () => {
      if (!autoPlayEnabled || autoPlayAttemptedRef.current || document.hidden) return;
      autoPlayAttemptedRef.current = true;
      if (isMpegTs(item)) {
        const bufferedAhead = getLiveBufferedAhead(video);
        setLiveBufferAhead(bufferedAhead);
        if (!pendingLivePlayRef.current && bufferedAhead < liveStartupBufferSeconds) {
          pendingLivePlayRef.current = true;
          pendingLivePlayStartedAtRef.current = Date.now();
          setLiveBuffering(true);
          setError('');
          showControls();
          return;
        }
      }
      playMedia(video).catch(() => {
        setError('Clique novamente para iniciar a reproducao');
        showControls();
      });
    };
    const onLoaded = () => {
      clearPlayableError();
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      restoreProgress();
      resumeLiveIfNeeded();
      autoPlayIfRequested();
    };
    const onPlayable = () => {
      clearPlayableError();
      finishPendingLivePlay();
      resumeLiveIfNeeded();
      autoPlayIfRequested();
    };
    const onTime = () => {
      setCurrent(video.currentTime || 0);
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      const now = Date.now();
      if (now - lastSaveRef.current > 5000) {
        lastSaveRef.current = now;
        saveProgress();
      }
    };
    const onPlay = () => {
      setIsPlaying(true);
      if (type === 'channel') saveProgress();
    };
    const onPause = () => setIsPlaying(false);
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onEnterPip = () => setIsPip(true);
    const onLeavePip = () => setIsPip(false);
    const onVideoError = () => {
      window.setTimeout(() => {
        if (video.error && video.readyState < 2) {
          setError('O navegador nao conseguiu reproduzir este link');
        }
      }, 250);
    };
    const onEnded = () => {
      if (isMpegTs(item)) {
        restartLiveStream();
      } else {
        if (shouldAutoplayNext && type === 'episode' && item?.nextEpisode?.id) {
          goToNextEpisode({ autoplay: true, replace: true });
          return;
        }
        saveProgress({ completed: true });
      }
    };

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('loadeddata', onPlayable);
    video.addEventListener('canplay', onPlayable);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('enterpictureinpicture', onEnterPip);
    video.addEventListener('leavepictureinpicture', onLeavePip);
    video.addEventListener('pause', saveProgress);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onVideoError);

    async function setupMedia() {
      if (isMpegTs(item)) {
        try {
          mpegtsLib = await loadMpegtsModule();
        } catch {
          if (!disposed) setError('Nao foi possivel carregar o player deste canal');
          return;
        }
        if (disposed) return;
        if (!mpegtsLib?.getFeatureList?.().mseLivePlayback) {
          setError('Este navegador nao suporta canais MPEG-TS');
          return;
        }

        tsPlayer = mpegtsLib.createPlayer(
          {
            type: 'mse',
            isLive: true,
            url: item.streamUrl
          },
          {
            enableWorker: false,
            enableStashBuffer: true,
            stashInitialSize: liveStashBufferBytes,
            lazyLoad: false,
            deferLoadAfterSourceOpen: false,
            liveBufferLatencyChasing: false,
            liveSync: false,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 30,
            autoCleanupMinBackwardDuration: liveBackwardBufferSeconds
          }
        );
        mediaPlayerRef.current = tsPlayer;
        tsPlayer.attachMediaElement(video);
        tsPlayer.load();
        tsPlayer.on(mpegtsLib.Events.ERROR, (_errorType, errorDetail) => {
          if (errorDetail === mpegtsLib.ErrorDetails.MEDIA_CODEC_UNSUPPORTED) {
            setError('Este canal usa um codec que o navegador nao consegue reproduzir');
            return;
          }
          restartLiveStream();
        });
        tsPlayer.on(mpegtsLib.Events.LOADING_COMPLETE, restartLiveStream);
        lastLiveTickRef.current = { position: video.currentTime || 0, updatedAt: Date.now() };
        liveWatchdog = window.setInterval(() => {
          finishPendingLivePlay();
          if (disposed || document.hidden || video.paused) {
            lastLiveTickRef.current = { position: video.currentTime || 0, updatedAt: Date.now() };
            return;
          }

          keepCloseToLiveEdge();
          const liveEdge = latestBufferedEnd();
          const bufferedAhead = liveEdge ? liveEdge - (video.currentTime || 0) : 0;
          if (bufferedAhead > 0 && bufferedAhead < liveMinBufferAheadSeconds) {
            lowLiveBufferSinceRef.current ||= Date.now();
            if (Date.now() - lowLiveBufferSinceRef.current > 5000) {
              restartLiveStream();
            }
          } else {
            lowLiveBufferSinceRef.current = 0;
          }

          const now = Date.now();
          const lastTick = lastLiveTickRef.current;
          if ((video.currentTime || 0) > lastTick.position + 0.25) {
            lastLiveTickRef.current = { position: video.currentTime || 0, updatedAt: now };
            return;
          }
          if (now - lastTick.updatedAt > liveStallTimeoutMs) {
            restartLiveStream();
          }
        }, 3000);
        return;
      }

      if (isHlsUrl(item.streamUrl)) {
        try {
          const Hls = await loadHlsModule();
          if (disposed) return;
          if (Hls?.isSupported?.()) {
            hls = new Hls({ enableWorker: true, lowLatencyMode: true });
            mediaPlayerRef.current = hls;
            hls.loadSource(item.streamUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal) setError('Nao foi possivel carregar este link HLS');
            });
            return;
          }
        } catch {}
      }

      video.src = item.streamUrl;
      video.load();
    }

    setupMedia();

    return () => {
      disposed = true;
      pendingLivePlayRef.current = false;
      setLiveBuffering(false);
      saveProgress({ video });
      window.clearInterval(liveWatchdog);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('loadeddata', onPlayable);
      video.removeEventListener('canplay', onPlayable);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('enterpictureinpicture', onEnterPip);
      video.removeEventListener('leavepictureinpicture', onLeavePip);
      video.removeEventListener('pause', saveProgress);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onVideoError);
      if (mediaPlayerRef.current === tsPlayer || mediaPlayerRef.current === hls) {
        mediaPlayerRef.current = null;
      }
      destroyMediaInstance(hls);
      destroyMediaInstance(tsPlayer);
      releaseVideoElement(video);
    };
  }, [autoPlayEnabled, id, isLive, item, navigate, saveProgress, shouldAutoplayNext, streamReloadKey, type]);

  function showControls() {
    setControlsVisible(true);
    window.clearTimeout(hideTimerRef.current);
    if (isPlaying && !error) {
      hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2800);
    }
  }

  useEffect(() => {
    function pauseLiveInBackground() {
      const video = videoRef.current;
      if (!isLive || !video) return;
      backgroundPausedRef.current = backgroundPausedRef.current || !video.paused;
      shouldResumeLiveRef.current = false;
      pendingLivePlayRef.current = false;
      setLiveBuffering(false);
      mediaPlayerRef.current?.pause?.();
      video.pause();
      setIsPlaying(false);
    }

    function onVisibilityChange() {
      if (document.hidden) {
        pauseLiveInBackground();
        return;
      }
      if (backgroundPausedRef.current) {
        backgroundPausedRef.current = false;
        setError('Canal pausado em segundo plano. Clique em reproduzir para retomar.');
        showControls();
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', pauseLiveInBackground);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', pauseLiveInBackground);
    };
  }, [isLive]);

  useEffect(() => {
    const video = videoRef.current;
    const remote = video?.remote;
    if (!remote) {
      setRemotePlaybackState('unsupported');
      setRemotePlaybackAvailable(false);
      return undefined;
    }

    let cancelled = false;
    let availabilityId = null;
    const updateState = () => setRemotePlaybackState(remote.state || 'disconnected');

    setRemotePlaybackState(remote.state || 'disconnected');
    setRemotePlaybackAvailable(true);
    remote.watchAvailability?.((available) => {
      if (!cancelled) setRemotePlaybackAvailable(Boolean(available));
    })
      .then((idValue) => {
        availabilityId = idValue;
      })
      .catch(() => {
        if (!cancelled) setRemotePlaybackAvailable(true);
      });

    remote.addEventListener?.('connecting', updateState);
    remote.addEventListener?.('connect', updateState);
    remote.addEventListener?.('disconnect', updateState);

    return () => {
      cancelled = true;
      if (availabilityId !== null) remote.cancelWatchAvailability?.(availabilityId).catch?.(() => {});
      remote.removeEventListener?.('connecting', updateState);
      remote.removeEventListener?.('connect', updateState);
      remote.removeEventListener?.('disconnect', updateState);
    };
  }, [item?.streamUrl]);

  function fullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }
    shellRef.current?.requestFullscreen?.();
  }

  function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const total = Math.floor(value);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function formatClock(value) {
    if (!value) return '';
    return new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function formatFinishClock(secondsLeft) {
    if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) return '';
    const rate = videoRef.current?.playbackRate && videoRef.current.playbackRate > 0
      ? videoRef.current.playbackRate
      : 1;
    return new Date(Date.now() + (secondsLeft / rate) * 1000).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  async function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (isMpegTs(item)) {
        const bufferedAhead = getLiveBufferedAhead(video);
        setLiveBufferAhead(bufferedAhead);
        if (!pendingLivePlayRef.current && bufferedAhead < liveStartupBufferSeconds) {
          pendingLivePlayRef.current = true;
          pendingLivePlayStartedAtRef.current = Date.now();
          setLiveBuffering(true);
          setError('');
          showControls();
          return;
        }
      }

      try {
        setError('');
        pendingLivePlayRef.current = false;
        setLiveBuffering(false);
        await playMedia(video);
      } catch {
        setError('Clique novamente para iniciar a reproducao');
      }
    } else {
      shouldResumeLiveRef.current = false;
      pendingLivePlayRef.current = false;
      setLiveBuffering(false);
      mediaPlayerRef.current?.pause?.();
      video.pause();
    }
  }

  function seek(value) {
    const video = videoRef.current;
    if (!video || isLive) return;
    video.currentTime = Math.min(Math.max(Number(value) || 0, 0), duration || Number.MAX_SAFE_INTEGER);
    setCurrent(video.currentTime);
  }

  function skip(seconds) {
    const video = videoRef.current;
    if (!video || isLive) return;
    seek((video.currentTime || 0) + seconds);
  }

  function changeVolume(value) {
    const video = videoRef.current;
    if (!video) return;
    const next = Math.min(1, Math.max(0, Number(value)));
    video.volume = next;
    video.muted = next === 0 ? true : false;
    setVolume(next);
    setMuted(video.muted);
  }

  function changeSource(value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('source', value);
    else next.delete('source');
    pendingLivePlayRef.current = false;
    shouldResumeLiveRef.current = false;
    setLiveBuffering(false);
    setIsPlaying(false);
    setSearchParams(next, { replace: true });
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  async function togglePip() {
    const video = videoRef.current;
    if (!video || !document.pictureInPictureEnabled) {
      setError('Picture-in-Picture nao esta disponivel neste navegador');
      return;
    }

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      setError('Nao foi possivel abrir Picture-in-Picture neste video');
    }
  }

  async function openRemotePlayback() {
    const video = videoRef.current;
    if (!video?.remote?.prompt) {
      setError('Transmissao nao esta disponivel neste navegador. No Chrome, tente o menu Transmitir.');
      showControls();
      return;
    }

    try {
      setError('');
      await video.remote.prompt();
      setRemotePlaybackState(video.remote.state || 'connecting');
    } catch (err) {
      if (err?.name === 'NotAllowedError') return;
      if (err?.name === 'NotFoundError') {
        setError('Nenhuma TV ou Chromecast encontrado na rede.');
      } else if (err?.name === 'NotSupportedError') {
        setError('Este video nao esta disponivel para transmissao neste navegador.');
      } else {
        setError('Nao foi possivel abrir a transmissao para TV.');
      }
      showControls();
    }
  }

  async function goToNextEpisode(options = {}) {
    const nextEpisodeId = item?.nextEpisode?.id;
    if (!nextEpisodeId || nextEpisodeBusy) return;

    setNextEpisodeBusy(true);
    try {
      if (type === 'episode') {
        const video = videoRef.current;
        const playbackDuration = Number.isFinite(video?.duration) ? video.duration : duration;
        await apiFetch('/progress/status', {
          method: 'PUT',
          body: {
            type: 'episode',
            id: Number(id),
            completed: true,
            duration: playbackDuration > 0 ? playbackDuration : 0
          }
        });
      }
    } catch {
      // If saving fails, continue playback flow and open the next episode anyway.
    }

    navigate(`/watch/episode/${nextEpisodeId}${options.autoplay ? '?autoplay=1' : ''}`, {
      replace: options.replace !== false
    });
  }

  function goBackFromPlayer() {
    if (type === 'episode' && item?.seriesId) {
      navigate(`/series/${item.seriesId}`, { replace: true });
      return;
    }
    if (type === 'movie') {
      navigate(`/movies/${id}`, { replace: true });
      return;
    }
    if (type === 'channel') {
      navigate('/canais', { replace: true });
      return;
    }
    navigate(-1);
  }

  useEffect(() => {
    setGuideOpen(false);
  }, [id, type]);

  useEffect(() => {
    function onKey(event) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
      showControls();
      if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
      }
      if (event.key === 'ArrowLeft') skip(-10);
      if (event.key === 'ArrowRight') skip(10);
      if (event.key.toLowerCase() === 'f') fullscreen();
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
      showControls();
    }

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  });

  useEffect(() => {
    if (isPlaying && !error) {
      showControls();
    } else {
      setControlsVisible(true);
      window.clearTimeout(hideTimerRef.current);
    }
    return () => window.clearTimeout(hideTimerRef.current);
  }, [error, isPlaying]);

  return (
    <div
      ref={shellRef}
      onMouseMove={showControls}
      onMouseDown={showControls}
      onTouchStart={showControls}
      className={`fixed inset-0 h-[100dvh] w-screen overflow-hidden bg-black text-white ${controlsVisible ? 'cursor-default' : 'cursor-none'}`}
    >
      <div className={`pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/82 via-black/42 to-transparent p-4 pb-20 transition-opacity duration-300 sm:p-6 sm:pb-24 ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className={`${controlsVisible ? 'pointer-events-auto' : 'pointer-events-none'} flex items-center justify-between gap-3`}>
          <button onClick={goBackFromPlayer} className="inline-flex items-center gap-2 rounded bg-black/64 px-3 py-2 text-sm font-bold text-white backdrop-blur hover:bg-black/80">
            <ArrowLeft size={18} />
            Voltar
          </button>
          <div className="flex items-center gap-2">
            <FavoriteButton
              type={favoriteType}
              id={item?.id}
              initial={item?.isFavorite}
              onChange={(next) => setItem((current) => current ? { ...current, isFavorite: next } : current)}
            />
            <button onClick={fullscreen} className="grid size-10 place-items-center rounded bg-black/64 text-white backdrop-blur hover:bg-black/80" title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}>
              {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            </button>
          </div>
        </div>

        <div className="mt-4 max-w-3xl">
          <p className="truncate text-xl font-black sm:text-3xl">{item?.title || 'Carregando...'}</p>
          {item?.seriesTitle && <p className="mt-1 text-sm text-slate-300">{item.seriesTitle}</p>}
          {error && <p className="mt-2 max-w-xl text-sm text-red-300">{error}</p>}
        </div>
      </div>

      <video
        key={`${type}-${id}-${sourceParam || 'primary'}-${streamReloadKey}`}
        ref={videoRef}
        playsInline
        poster={item?.backdropUrl || item?.posterUrl || undefined}
        onClick={togglePlay}
        onDoubleClick={fullscreen}
        className="h-full w-full bg-black object-contain"
      />

      {item?.nextEpisode && (
        <div className={`pointer-events-none absolute inset-x-0 bottom-28 z-20 flex justify-end px-4 transition-opacity duration-300 sm:bottom-32 sm:px-8 ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}>
          <div className={controlsVisible ? 'pointer-events-auto' : 'pointer-events-none'}>
            <button
              type="button"
              disabled={nextEpisodeBusy}
              onClick={() => goToNextEpisode()}
              className="inline-flex items-center justify-center gap-2 rounded bg-white px-4 py-3 text-sm font-black text-ink hover:bg-slate-200 disabled:cursor-wait disabled:opacity-70"
            >
              Proximo
              <SkipForward size={17} fill="currentColor" />
            </button>
          </div>
        </div>
      )}

      {hasGuide && (
        <div className={`pointer-events-none absolute inset-x-0 bottom-24 z-40 px-0 transition-all duration-300 sm:bottom-28 ${guideOpen ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'}`}>
          <div className={`${guideOpen ? 'pointer-events-auto' : 'pointer-events-none'} w-full border-y border-white/10 bg-black/58 p-3 text-white shadow-2xl backdrop-blur-xl sm:p-4`}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-black uppercase text-ocean">Guia</p>
                <h2 className="truncate text-lg font-black">{item.title}</h2>
              </div>
              <button onClick={() => setGuideOpen(false)} className="grid size-9 shrink-0 place-items-center rounded bg-white/10 text-white hover:bg-white/16" title="Fechar guia">
                <Minimize size={17} />
              </button>
            </div>

            <div className="no-scrollbar flex max-h-72 gap-3 overflow-x-auto overflow-y-hidden pb-1">
              {item.guide.slice(0, 18).map((program) => {
                const active = item.currentProgram?.id === program.id;
                return (
                  <div key={program.id} className={`w-64 shrink-0 rounded border p-3 ${active ? 'border-ocean bg-ocean/16' : 'border-white/10 bg-white/8'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-slate-400">
                          {formatClock(program.startAt)} - {formatClock(program.stopAt)}
                        </p>
                        <p className="mt-1 line-clamp-2 text-sm font-bold text-white">{program.title}</p>
                      </div>
                      {active && <span className="shrink-0 rounded bg-ocean px-2 py-1 text-[11px] font-black uppercase text-ink">Agora</span>}
                    </div>
                    {program.description && <p className="mt-2 line-clamp-3 text-xs text-slate-300">{program.description}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className={`pointer-events-none absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/88 via-black/54 to-transparent p-4 pt-20 transition-opacity duration-300 sm:p-6 sm:pt-24 ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className={`${controlsVisible ? 'pointer-events-auto' : 'pointer-events-none'} w-full`}>
          {isLive ? (
            <div className="h-1 w-full rounded-full bg-brand" />
          ) : (
            <input
              type="range"
              min="0"
              max={duration || current || 0}
              step="0.1"
              value={Math.min(current, duration || current || 0)}
              onChange={(event) => seek(event.target.value)}
              className="h-1 w-full accent-brand"
            />
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button onClick={togglePlay} className="grid size-11 place-items-center rounded-full bg-white text-ink hover:bg-slate-200" title={isPlaying ? 'Pausar' : 'Reproduzir'}>
              {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
            </button>
            {!isLive && (
              <>
                <button onClick={() => skip(-10)} className="grid size-10 place-items-center rounded bg-white/10 text-white hover:bg-white/16" title="Voltar 10s">
                  <RotateCcw size={18} />
                </button>
                <button onClick={() => skip(10)} className="grid size-10 place-items-center rounded bg-white/10 text-white hover:bg-white/16" title="Avancar 10s">
                  <RotateCw size={18} />
                </button>
              </>
            )}
            <div className="min-w-32 text-sm font-bold text-slate-200">
              <p>{isLive ? 'Ao vivo' : `${formatTime(current)} / ${formatTime(duration)}`}</p>
              {finishClock && <p className="mt-0.5 text-[11px] font-semibold text-slate-400">Termina as {finishClock}</p>}
            </div>
            {isLive && (liveBuffering || item?.currentProgram) && (
              <div className="order-last min-w-0 basis-full px-2 text-center sm:order-none sm:basis-auto sm:flex-1 sm:px-6">
                <p className="truncate text-sm font-black text-white sm:text-base">
                  {liveBuffering
                    ? `Carregando buffer ${Math.min(liveStartupBufferSeconds, Math.floor(liveBufferAhead))}/${liveStartupBufferSeconds}s`
                    : item.currentProgram.title}
                </p>
                {!liveBuffering && item?.nextProgram && (
                  <p className="mt-0.5 truncate text-[11px] font-semibold text-slate-300 sm:text-xs">
                    Proximo: {item.nextProgram.title}
                  </p>
                )}
              </div>
            )}
            <div className="ml-auto flex items-center gap-2">
              {sourceOptions.length > 1 && (
                <label className="flex h-10 max-w-[230px] items-center gap-2 rounded bg-white/10 px-2 text-white hover:bg-white/16" title="Qualidade e idioma">
                  <Server size={17} className="shrink-0" />
                  <select
                    value={item?.activeSourceId || ''}
                    onChange={(event) => changeSource(event.target.value)}
                    className="min-w-0 bg-transparent text-xs font-bold outline-none"
                  >
                    {sourceOptions.map((source, index) => (
                      <option key={source.id || `source-${index}`} value={source.id || ''} className="bg-ink text-white">
                        {sourceSummary(source, index)}{source.sourceHost ? ` - ${source.sourceHost}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {hasGuide && (
                <button onClick={() => setGuideOpen((value) => !value)} className={`grid size-10 place-items-center rounded text-white hover:bg-white/16 ${guideOpen ? 'bg-ocean/80 text-ink' : 'bg-white/10'}`} title="Guia">
                  <CalendarDays size={18} />
                </button>
              )}
              <button onClick={toggleMute} className="grid size-10 place-items-center rounded bg-white/10 text-white hover:bg-white/16" title={muted ? 'Ativar som' : 'Mutar'}>
                {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={muted ? 0 : volume}
                onChange={(event) => changeVolume(event.target.value)}
                className="hidden w-24 accent-brand sm:block"
              />
              <button onClick={togglePip} className="grid size-10 place-items-center rounded bg-white/10 text-white hover:bg-white/16" title={isPip ? 'Sair do Picture-in-Picture' : 'Picture-in-Picture'}>
                <PictureInPicture size={18} />
              </button>
              <button
                onClick={openRemotePlayback}
                disabled={remotePlaybackSupported && !remotePlaybackAvailable}
                className={`grid size-10 place-items-center rounded text-white hover:bg-white/16 disabled:cursor-not-allowed disabled:opacity-45 ${
                  remotePlaybackState === 'connected' || remotePlaybackState === 'connecting' ? 'bg-ocean/80 text-ink' : 'bg-white/10'
                }`}
                title={remotePlaybackState === 'connected' ? 'Transmitindo para TV' : 'Transmitir para TV'}
              >
                <Cast size={18} />
              </button>
              <button onClick={fullscreen} className="grid size-10 place-items-center rounded bg-white/10 text-white hover:bg-white/16" title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}>
                {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
