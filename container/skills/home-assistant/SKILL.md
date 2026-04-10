---
name: home-assistant
description: "ha CLI: Control smart home devices via the Home Assistant REST API."
metadata:
  openclaw:
    category: "smart-home"
    requires:
      bins:
        - ha
      env:
        - HASS_SERVER
---

# ha — Home Assistant CLI

Lightweight CLI for controlling smart home devices through the Home Assistant REST API. Credentials are injected by the OneCLI proxy — no tokens are stored in the container.

## When to use

Use this tool when the user asks to:
- Check the state of lights, switches, sensors, climate, or other devices
- Turn devices on or off
- Call any Home Assistant service (set brightness, change temperature, lock doors, etc.)
- List available entities or device states

## Commands

```bash
# List all entities (or filter by domain)
ha states                    # all entities
ha states light              # only lights
ha states climate            # only climate devices
ha states sensor             # only sensors

# Get detailed state of a single entity
ha state light.kitchen
ha state climate.living_room

# Turn on / off
ha on light.kitchen
ha off switch.fan

# Call any service with key=value parameters
ha call light.turn_on entity_id=light.kitchen brightness=200
ha call climate.set_temperature entity_id=climate.living_room temperature=22
ha call cover.open_cover entity_id=cover.garage
ha call lock.lock entity_id=lock.front_door
```

## Tips

- Use `ha states` with a domain filter first to discover entity IDs before acting on them.
- Entity IDs follow the pattern `<domain>.<name>` (e.g. `light.bedroom`, `switch.water_heater`).
- The `ha call` command accepts arbitrary `key=value` pairs — check HA documentation for service-specific parameters.
- Values are auto-parsed: numbers become integers/floats, `true`/`false` become booleans.

## Security

- Never expose or log credentials — authentication is handled transparently by the proxy.
- Always confirm destructive actions (locking doors, disabling alarms, opening covers) with the user before executing.
