# GreenLoop IoT Campus Power Dataset Specification (3-Month Baseline)

## 1. Dataset Overview
- **Project Name:** GreenLoop SCADA & AI Anomaly Detection Engine
- **Timeframe:** Exactly 90 Days (3 Months)
- **Granularity:** Hourly Aggregated Telemetry Samples (1-hour step)
- **Total Records:** 25,920 time-series entries
- **Sensors Covered:** 12 ESP32 + PZEM-004T v3.0 AC Power Nodes
- **File Formats:**
  - `greenloop_3month_training_dataset.csv` (6.08 MB) — CSV for Excel, Python Pandas, R
  - `training_baseline_3months_all_sensors.json` (8.82 MB) — Full JSON with cryptographic HMAC-SHA256 signatures

---

## 2. Sensor Node Inventory & Facility Classifications

| Node ID | Sensor Transducer | Facility Type | Building / Location | Baseline Load (kW) | Peak Load (kW) | Total 90-Day Records |
|---|---|---|---|---|---|---|
| **ESP32_HA_F1** | PZEM_004T_HA_F1 | `hostel` | Building A - Floor 1 | 25 kW | 45 kW | 2,160 |
| **ESP32_HA_F2** | PZEM_004T_HA_F2 | `hostel` | Building A - Floor 2 | 28 kW | 50 kW | 2,160 |
| **ESP32_HA_F3** | PZEM_004T_HA_F3 | `hostel` | Building A - Floor 3 | 26 kW | 46 kW | 2,160 |
| **ESP32_HA_F4** | PZEM_004T_HA_F4 | `hostel` | Building A - Floor 4 | 15 kW | 33 kW | 2,160 |
| **ESP32_AB_F1** | PZEM_004T_AB_F1 | `college` | Academic Block - Wing A | 10 kW | 45 kW | 2,160 |
| **ESP32_AB_F2** | PZEM_004T_AB_F2 | `college` | Academic Block - Wing B | 10 kW | 42 kW | 2,160 |
| **ESP32_AUDIT** | PZEM_004T_AUDIT | `college` | Academic Block - Auditorium | 4 kW | 32 kW | 2,160 |
| **ESP32_LIB_F1** | PZEM_004T_LIB_F1 | `college` | Library - Main Hall | 8 kW | 26 kW | 2,160 |
| **ESP32_LIB_F2** | PZEM_004T_LIB_F2 | `college` | Library - Study Wing | 6 kW | 20 kW | 2,160 |
| **ESP32_LAB_CHEM** | PZEM_004T_LAB_CHEM | `college` | Labs - Chemistry Lab | 12 kW | 37 kW | 2,160 |
| **ESP32_LAB_PHY** | PZEM_004T_LAB_PHY | `college` | Labs - Physics Lab | 14 kW | 40 kW | 2,160 |
| **ESP32_LAB_BIO** | PZEM_004T_LAB_BIO | `college` | Labs - Biology / Biotech Lab | 11 kW | 33 kW | 2,160 |

---

## 3. Telemetry Register Schema (PZEM-004T v3.0 Standard)

| Column Header | Data Type | Units / Range | Engineering Description |
|---|---|---|---|
| `timestamp_ist` | String | ISO 8601 (+05:30) | Indian Standard Time measurement timestamp |
| `device_id` | String | ESP32_XX_XX | Unique ESP32 microcontroller identifier |
| `sensor_id` | String | PZEM_004T_XX | Dedicated Modbus transducer sensor address |
| `building_label` | String | Human readable | Physical campus location |
| `facility_type` | String | `college` / `hostel` | Facility profile for ML prior template blending |
| `voltage_v` | Float | 220.0 - 245.0 V | True RMS line voltage (nominal 230V AC ± 10%) |
| `current_a` | Float | 0.0 - 100.0 A | CT coil phase current |
| `active_power_kw` | Float | kW ($P = V \times I \times PF$) | Real consumed power in kilowatts |
| `apparent_power_kva`| Float | kVA ($S = V \times I$) | Apparent electrical supply burden |
| `power_factor` | Float | 0.85 - 0.99 | Power factor (cos phi efficiency metric) |
| `frequency_hz` | Float | 49.8 - 50.2 Hz | Grid supply frequency (CEA grid code) |
| `cumulative_energy_kwh`| Float | kWh | Cumulative meter counter register |
| `hour_of_day` | Integer | 0 - 23 | Time of day for diurnal load profiling |
| `day_of_week` | Integer | 0 - 6 | Day indicator (0 = Sunday, 6 = Saturday) |
| `is_weekend` | Binary | 0 or 1 | Weekend flag (captures 40-60% campus load drop) |
| `is_anomaly_ground_truth` | Binary | 0 (Normal) | Ground-truth benchmark label for ML training |
| `hmac_sha256_signature` | String | Hex (64 chars) | Cryptographic signature verifying tamper resistance |

---

## 4. Summary Statistics for Judges & Viva Panel

- **Mean Voltage Across Campus:** 230.1 V (Standard Deviation: 2.8 V)
- **Mean Grid Frequency:** 50.01 Hz (within CEA limits)
- **Campus Power Factor:** Mean 0.952 (above statutory penalty threshold of 0.90)
- **Model Ingestion Status:** Ingested via `POST /v1/sensors/{id}/fit` into the GreenLoop AI Engine
- **Resulting Learned Threshold:** Adaptive Conformal Quantile $k = 3.5\sigma$ (High Confidence)
