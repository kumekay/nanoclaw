package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetStates(t *testing.T) {
	states := []map[string]any{
		{"entity_id": "light.kitchen", "state": "on"},
		{"entity_id": "light.bedroom", "state": "off"},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/states" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("missing or wrong auth header: %s", r.Header.Get("Authorization"))
		}
		json.NewEncoder(w).Encode(states)
	}))
	defer srv.Close()

	cfg := HAConfig{Server: srv.URL, Token: "test-token"}
	result, err := getStates(cfg, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 states, got %d", len(result))
	}
}

func TestGetStatesFilter(t *testing.T) {
	states := []map[string]any{
		{"entity_id": "light.kitchen", "state": "on"},
		{"entity_id": "switch.fan", "state": "off"},
		{"entity_id": "light.bedroom", "state": "off"},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(states)
	}))
	defer srv.Close()

	cfg := HAConfig{Server: srv.URL, Token: "test-token"}
	result, err := getStates(cfg, "light")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 lights, got %d", len(result))
	}
	for _, s := range result {
		id := s["entity_id"].(string)
		if id != "light.kitchen" && id != "light.bedroom" {
			t.Errorf("unexpected entity: %s", id)
		}
	}
}

func TestGetStatesHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}))
	defer srv.Close()

	cfg := HAConfig{Server: srv.URL, Token: "bad-token"}
	_, err := getStates(cfg, "")
	if err == nil {
		t.Fatal("expected error on 401")
	}
}

func TestGetState(t *testing.T) {
	state := map[string]any{
		"entity_id":  "light.kitchen",
		"state":      "on",
		"attributes": map[string]any{"brightness": float64(200)},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/states/light.kitchen" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(state)
	}))
	defer srv.Close()

	cfg := HAConfig{Server: srv.URL, Token: "test-token"}
	result, err := getState(cfg, "light.kitchen")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result["entity_id"] != "light.kitchen" {
		t.Errorf("unexpected entity_id: %v", result["entity_id"])
	}
}

func TestCallService(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/services/light/turn_on" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["entity_id"] != "light.kitchen" {
			t.Errorf("unexpected entity_id: %v", body["entity_id"])
		}
		json.NewEncoder(w).Encode([]any{})
	}))
	defer srv.Close()

	cfg := HAConfig{Server: srv.URL, Token: "test-token"}
	_, err := callService(cfg, "light", "turn_on", map[string]any{
		"entity_id":  "light.kitchen",
		"brightness": 128,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestTurnOn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/services/homeassistant/turn_on" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["entity_id"] != "light.kitchen" {
			t.Errorf("unexpected entity_id: %v", body["entity_id"])
		}
		json.NewEncoder(w).Encode([]any{})
	}))
	defer srv.Close()

	cfg := HAConfig{Server: srv.URL, Token: "test-token"}
	err := turnOn(cfg, "light.kitchen")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestTurnOff(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/services/homeassistant/turn_off" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode([]any{})
	}))
	defer srv.Close()

	cfg := HAConfig{Server: srv.URL, Token: "test-token"}
	err := turnOff(cfg, "light.kitchen")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNoAuthHeaderWhenNoToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("expected no Authorization header when token is empty")
		}
		json.NewEncoder(w).Encode([]any{})
	}))
	defer srv.Close()

	cfg := HAConfig{Server: srv.URL}
	_, err := getStates(cfg, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestParseKeyValues(t *testing.T) {
	args := []string{"entity_id=light.kitchen", "brightness=200", "on=true", "ratio=0.5"}
	data := parseKeyValues(args)

	if data["entity_id"] != "light.kitchen" {
		t.Errorf("expected string, got %v", data["entity_id"])
	}
	if v, ok := data["brightness"].(int); !ok || v != 200 {
		t.Errorf("expected int 200, got %v", data["brightness"])
	}
	if v, ok := data["on"].(bool); !ok || v != true {
		t.Errorf("expected bool true, got %v", data["on"])
	}
	if v, ok := data["ratio"].(float64); !ok || v != 0.5 {
		t.Errorf("expected float 0.5, got %v", data["ratio"])
	}
}
