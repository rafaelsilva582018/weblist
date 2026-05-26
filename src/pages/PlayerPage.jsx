import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { ArrowLeft, CalendarDays, Maximize, Minimize, Pause, PictureInPicture, Play, RotateCcw, RotateCw, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../api.js';

function isHlsUrl(url = '') {
  return /\.m3u8(\?|#|$)/i.test(url);
}

function isMpegTs(item) {
  return item?.streamFormat === 'mpegts' || /\.ts(\?|#|$)/i.test(item?.directStreamUrl || item?.streamUrl || '');
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

export default function PlayerPage() {
  const { type, id } = useParams();
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const shellRef = useRef(null);
  const mediaPlayerRef = useRef(null);
  const lastSaveRef = useRef(0);
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
  const [streamReloadKey, setStreamReloadKey] = useState(0);
  const [guideOpen, setGuideOpen] = useState(false);
  const [liveBuffering, setLiveBuffering] = useState(false);
  const [liveBufferAhead, setLiveBufferAhead] = useState(0);
  const hideTimerRef = useRef(null);
  const isLive = type === 'channel' || item?.streamFormat === 'mpegts';
  const hasGuide = item?.guide?.length > 0;

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

  const saveProgress = useCallback(() => {
    const video = videoRef.current;
    if (!video || !item || type === 'channel') return;

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    apiFetch('/progress', {
      method: 'POST',
      body: {
        type,
        id: Number(id),
        position: video.currentTime || 0,
        duration
      }
    }).catch(() => {});
  }, [id, item, type]);

  useEffect(() => {
    apiFetch(`/play/${type}/${id}`)
      .then((data) => setItem(data.item))
      .catch((err) => setError(err.message));
  }, [id, type]);

  useEffect(() => {
    if (!item?.streamUrl || !videoRef.current) return undefined;

    const video = videoRef.current;
    let hls;
    let tsPlayer;
    let liveWatchdog;
    let disposed = false;
    mediaPlayerRef.current = null;
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

    if (isMpegTs(item)) {
      if (!mpegts.getFeatureList().mseLivePlayback) {
        setError('Este navegador nao suporta canais MPEG-TS');
      } else {
        tsPlayer = mpegts.createPlayer(
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
        tsPlayer.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
          if (errorDetail === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED) {
            setError('Este canal usa um codec que o navegador nao consegue reproduzir');
            return;
          }
          restartLiveStream();
        });
        tsPlayer.on(mpegts.Events.LOADING_COMPLETE, restartLiveStream);
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
      }
    } else if (isHlsUrl(item.streamUrl) && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      mediaPlayerRef.current = hls;
      hls.loadSource(item.streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setError('Nao foi possivel carregar este link HLS');
      });
    } else {
      video.src = item.streamUrl;
      video.load();
    }

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
    const onLoaded = () => {
      clearPlayableError();
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      restoreProgress();
      resumeLiveIfNeeded();
    };
    const onPlayable = () => {
      clearPlayableError();
      finishPendingLivePlay();
      resumeLiveIfNeeded();
    };
    const onTime = () => {
      setCurrent(video.currentTime || 0);
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      const now = Date.now();
      if (type !== 'channel' && now - lastSaveRef.current > 5000) {
        lastSaveRef.current = now;
        saveProgress();
      }
    };
    const onPlay = () => setIsPlaying(true);
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
        saveProgress();
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

    return () => {
      disposed = true;
      pendingLivePlayRef.current = false;
      setLiveBuffering(false);
      saveProgress();
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
      hls?.destroy();
      tsPlayer?.destroy();
    };
  }, [id, item, saveProgress, streamReloadKey, type]);

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
      className={`min-h-screen bg-black text-white ${controlsVisible ? 'cursor-default' : 'cursor-none'}`}
    >
      <div className={`pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/82 via-black/42 to-transparent p-4 pb-20 transition-opacity duration-300 sm:p-6 sm:pb-24 ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className={`${controlsVisible ? 'pointer-events-auto' : 'pointer-events-none'} flex items-center justify-between gap-3`}>
          <button onClick={() => navigate(-1)} className="inline-flex items-center gap-2 rounded bg-black/64 px-3 py-2 text-sm font-bold text-white backdrop-blur hover:bg-black/80">
            <ArrowLeft size={18} />
            Voltar
          </button>
          <button onClick={fullscreen} className="grid size-10 place-items-center rounded bg-black/64 text-white backdrop-blur hover:bg-black/80" title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}>
            {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>
        </div>

        <div className="mt-4 max-w-3xl">
          <p className="truncate text-xl font-black sm:text-3xl">{item?.title || 'Carregando...'}</p>
          {item?.seriesTitle && <p className="mt-1 text-sm text-slate-300">{item.seriesTitle}</p>}
          {error && <p className="mt-2 max-w-xl text-sm text-red-300">{error}</p>}
        </div>
      </div>

      <video
        ref={videoRef}
        playsInline
        poster={item?.backdropUrl || item?.posterUrl || undefined}
        onClick={togglePlay}
        className="h-screen w-screen bg-black object-contain"
      />

      {item?.nextEpisode && (
        <div className={`pointer-events-none absolute inset-x-0 bottom-28 z-20 flex justify-end px-4 transition-opacity duration-300 sm:bottom-32 sm:px-8 ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}>
          <div className={controlsVisible ? 'pointer-events-auto' : 'pointer-events-none'}>
            <Link
              to={`/watch/episode/${item.nextEpisode.id}`}
              className="inline-flex items-center justify-center gap-2 rounded bg-white px-4 py-3 text-sm font-black text-ink hover:bg-slate-200"
            >
              Proximo
              <SkipForward size={17} fill="currentColor" />
            </Link>
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
            <div className="min-w-28 text-sm font-bold text-slate-200">
              {isLive ? 'Ao vivo' : `${formatTime(current)} / ${formatTime(duration)}`}
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
