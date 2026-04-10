package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// HAConfig holds connection details for the Home Assistant instance.
// When Token is empty, the HTTP proxy (OneCLI) is expected to inject credentials.
type HAConfig struct {
	Server string
	Token  string
}

func doRequest(cfg HAConfig, method, url string, body io.Reader) ([]byte, error) {
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.Token)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HA API error: %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	return data, nil
}

func getStates(cfg HAConfig, filter string) ([]map[string]any, error) {
	data, err := doRequest(cfg, "GET", cfg.Server+"/api/states", nil)
	if err != nil {
		return nil, err
	}
	var states []map[string]any
	if err := json.Unmarshal(data, &states); err != nil {
		return nil, err
	}
	if filter == "" {
		return states, nil
	}
	prefix := filter + "."
	var filtered []map[string]any
	for _, s := range states {
		if id, ok := s["entity_id"].(string); ok && strings.HasPrefix(id, prefix) {
			filtered = append(filtered, s)
		}
	}
	return filtered, nil
}

func getState(cfg HAConfig, entityID string) (map[string]any, error) {
	data, err := doRequest(cfg, "GET", cfg.Server+"/api/states/"+entityID, nil)
	if err != nil {
		return nil, err
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return state, nil
}

func callService(cfg HAConfig, domain, service string, serviceData map[string]any) (json.RawMessage, error) {
	body, err := json.Marshal(serviceData)
	if err != nil {
		return nil, err
	}
	data, err := doRequest(cfg, "POST", cfg.Server+"/api/services/"+domain+"/"+service, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	return json.RawMessage(data), nil
}

func turnOn(cfg HAConfig, entityID string) error {
	_, err := callService(cfg, "homeassistant", "turn_on", map[string]any{"entity_id": entityID})
	return err
}

func turnOff(cfg HAConfig, entityID string) error {
	_, err := callService(cfg, "homeassistant", "turn_off", map[string]any{"entity_id": entityID})
	return err
}

func parseKeyValues(args []string) map[string]any {
	data := make(map[string]any)
	for _, arg := range args {
		eq := strings.Index(arg, "=")
		if eq == -1 {
			continue
		}
		key := arg[:eq]
		raw := arg[eq+1:]
		if raw == "true" {
			data[key] = true
		} else if raw == "false" {
			data[key] = false
		} else if v, err := strconv.Atoi(raw); err == nil {
			data[key] = v
		} else if v, err := strconv.ParseFloat(raw, 64); err == nil {
			data[key] = v
		} else {
			data[key] = raw
		}
	}
	return data
}

func configFromEnv() HAConfig {
	server := os.Getenv("HASS_SERVER")
	if server == "" {
		fmt.Fprintln(os.Stderr, "Error: HASS_SERVER must be set")
		os.Exit(1)
	}
	return HAConfig{
		Server: strings.TrimRight(server, "/"),
		Token:  os.Getenv("HASS_TOKEN"),
	}
}

const usage = `Usage:
  ha states [filter]                         List entities (filter by domain)
  ha state <entity_id>                       Get entity state
  ha on <entity_id>                          Turn on
  ha off <entity_id>                         Turn off
  ha call <domain.service> [key=value ...]   Call service`

func main() {
	args := os.Args[1:]
	if len(args) == 0 || args[0] == "help" {
		fmt.Println(usage)
		return
	}

	cfg := configFromEnv()
	cmd := args[0]

	switch cmd {
	case "states":
		filter := ""
		if len(args) > 1 {
			filter = args[1]
		}
		states, err := getStates(cfg, filter)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		for _, s := range states {
			id := s["entity_id"]
			state := s["state"]
			name := ""
			if attrs, ok := s["attributes"].(map[string]any); ok {
				if fn, ok := attrs["friendly_name"].(string); ok {
					name = " (" + fn + ")"
				}
			}
			fmt.Printf("%s: %s%s\n", id, state, name)
		}

	case "state":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: ha state <entity_id>")
			os.Exit(1)
		}
		state, err := getState(cfg, args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.Encode(state)

	case "on":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: ha on <entity_id>")
			os.Exit(1)
		}
		if err := turnOn(cfg, args[1]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("Turned on %s\n", args[1])

	case "off":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: ha off <entity_id>")
			os.Exit(1)
		}
		if err := turnOff(cfg, args[1]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("Turned off %s\n", args[1])

	case "call":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: ha call <domain.service> [key=value ...]")
			os.Exit(1)
		}
		parts := strings.SplitN(args[1], ".", 2)
		if len(parts) != 2 {
			fmt.Fprintln(os.Stderr, "Service must be domain.service (e.g. light.turn_on)")
			os.Exit(1)
		}
		data := parseKeyValues(args[2:])
		result, err := callService(cfg, parts[0], parts[1], data)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		var indented bytes.Buffer
		json.Indent(&indented, result, "", "  ")
		fmt.Println(indented.String())

	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s. Run \"ha help\" for usage.\n", cmd)
		os.Exit(1)
	}
}
