// SPDX-License-Identifier: AGPL-3.0-only
import * as netease from './providers/netease/index.js';
import * as qqmusic from './providers/qqmusic/index.js';
import { createFusion } from './fusion.js';

// Deferring host calls is also required when MyGo compiles/inspects a plugin.
const api = createFusion({ netease, qqmusic }, {
  storage: {
    get: key => globalThis.host.storage.get(key),
    set: (key, value) => globalThis.host.storage.set(key, value),
    remove: key => globalThis.host.storage.remove(key),
  },
  setting: key => globalThis.host.setting(key),
  crypto: { md5: text => globalThis.host.crypto.md5(text) },
});
export const {
  account, signIn, signOut, setSetting, home, browse, search, suggest, playlists, playlist,
  createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist, movePlaylistTrack,
  savePlaylist, recent, played, stream, lyrics, like, isLiked, liked,
  followArtist, shows, show, subscribeShow,
  album, artist, stations, stationNext, comments, likeComment, postComment,
} = api;
