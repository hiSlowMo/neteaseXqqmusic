// SPDX-License-Identifier: AGPL-3.0-only
// Injected as a Go overlay by test-runtime.mjs; the upstream checkout stays unchanged.
package plugin

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"mygo-music/internal/music"
)

type fusionRoundTripper func(*http.Request) (*http.Response, error)

func (f fusionRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// The final plugin bundle must work in the real moejs host, preserve provider routing,
// and reopen mixed playlists with a new VM using only synthetic music responses.
func TestFusionExternalBundle(t *testing.T) {
	dir := os.Getenv("FUSION_PLUGIN_DIR")
	if dir == "" {
		t.Fatal("FUSION_PLUGIN_DIR is required")
	}
	transport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = transport })
	var streams []string
	http.DefaultTransport = fusionRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Hostname() != "music.163.com" && r.URL.Hostname() != "interfacepc.music.163.com" && r.URL.Hostname() != "u.y.qq.com" {
			return nil, fmt.Errorf("fixture rejects network host %s", r.URL.Hostname())
		}
		var result any
		switch {
		case strings.Contains(r.URL.Path, "cloudsearch"):
			result = map[string]any{"code": 200, "result": map[string]any{"songs": []any{map[string]any{"id": 9, "name": "反方向的钟 (翻唱)"}}, "songCount": 1}}
		case strings.Contains(r.URL.Path, "/eapi/"):
			if err := r.ParseForm(); err != nil {
				return nil, err
			}
			data, err := hex.DecodeString(r.Form.Get("params"))
			if err != nil {
				return nil, err
			}
			// The fixed protocol key is derived from the EAPI request by the real
			// host; for these fixture endpoints it needn't be decoded: use the path.
			_ = data
			if strings.Contains(r.URL.Path, "song/detail") {
				result = map[string]any{"code": 200, "songs": []any{map[string]any{"id": 9, "name": "反方向的钟 (翻唱)", "ar": []any{map[string]any{"id": 7, "name": "翻唱歌手"}}, "al": map[string]any{"id": 8, "name": "Fixture"}, "dt": 120000}}, "privileges": []any{}}
			} else if strings.Contains(r.URL.Path, "player/url") {
				streams = append(streams, "netease")
				result = map[string]any{"code": 200, "data": []any{map[string]any{"id": 9, "code": 200, "url": "https://m1.music.126.net/test.mp3", "type": "mp3", "freeTrialInfo": nil}}}
			} else {
				return nil, fmt.Errorf("unexpected eapi path %s", r.URL.Path)
			}
		case r.URL.Hostname() == "u.y.qq.com":
			var request struct {
				Req struct {
					Method string `json:"method"`
				} `json:"req_0"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				return nil, err
			}
			var data any
			switch request.Req.Method {
			case "DoSearchForQQMusicDesktop":
				data = map[string]any{"body": map[string]any{"song": map[string]any{"list": []any{map[string]any{"id": 9, "mid": "fixtureMID", "title": "反方向的钟", "singer": []any{map[string]any{"mid": "artistMID", "name": "周杰伦"}}}}}}, "meta": map[string]any{"sum": 1}}
			case "get_song_detail_yqq":
				data = map[string]any{"track_info": map[string]any{"id": 9, "mid": "fixtureMID", "title": "反方向的钟", "file": map[string]any{"media_mid": "mediaMID"}}}
			case "CgiGetVkey":
				streams = append(streams, "qqmusic")
				data = map[string]any{"midurlinfo": []any{map[string]any{"songmid": "fixtureMID", "purl": "/test.mp3"}}, "sip": []string{"https://dl.stream.qqmusic.qq.com/"}}
			default:
				return nil, fmt.Errorf("unexpected QQ method %s", request.Req.Method)
			}
			result = map[string]any{"code": 0, "req_0": map[string]any{"code": 0, "data": data}}
		default:
			return nil, fmt.Errorf("unexpected fixture request %s", r.URL.Path)
		}
		body, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
	})
	data := t.TempDir()
	p, err := Load(dir, data)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { p.Close() }()
	found, err := p.Search("反方向的钟", music.SearchTracks, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(found.Tracks) != 2 || found.Tracks[0].ID != "qqmusic:fixtureMID" || found.Tracks[1].ID != "netease:9" || found.Tracks[0].Source != "music-fusion" {
		t.Fatalf("source/ranking lost: %+v", found.Tracks)
	}
	list, err := p.CreatePlaylist("Runtime mixed")
	if err != nil {
		t.Fatal(err)
	}
	if err := p.AddToPlaylist(list.ID, []string{found.Tracks[0].ID, found.Tracks[1].ID}); err != nil {
		t.Fatal(err)
	}
	for _, track := range found.Tracks {
		if _, err := p.Stream(track.ID, "standard"); err != nil {
			t.Fatal(err)
		}
	}
	if len(streams) != 2 || streams[0] != "qqmusic" || streams[1] != "netease" {
		t.Fatalf("wrong provider routing: %v", streams)
	}
	p.Close()
	p, err = Load(dir, data)
	if err != nil {
		t.Fatal(err)
	}
	got, err := p.Playlist(list.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tracks) != 2 || got.Tracks[0].ID != found.Tracks[0].ID || got.Tracks[1].ID != found.Tracks[1].ID {
		t.Fatalf("playlist lost after runtime restart: %+v", got)
	}
}
