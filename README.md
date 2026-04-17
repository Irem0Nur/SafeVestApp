# 🦺 SafeVest

SafeVest is a smart safety vest system designed to monitor worker health and environmental conditions in real-time using multiple sensors and a mobile application.


## 🏆 Presentation

This project was presented at the **Ege Career Fair (EGEKAF)**.

SafeVest was showcased as an innovative smart safety system focusing on real-time monitoring of environmental and health conditions using IoT technologies.

The project attracted attention for its multi-sensor integration and practical application in occupational safety.


## 🚀 Features

* 📡 Real-time environmental monitoring
* ❤️ Health tracking (heart rate & body temperature)
* 📍 GPS location tracking
* 🔊 Sound level & frequency analysis
* 🧭 Motion & fall detection
* 🔵 Bluetooth Low Energy (BLE) communication with ESP32
* ⚠️ Threshold-based risk alerts

## 🛠 Tech Stack

* React Native (TypeScript)
* ESP32 (Arduino)
* Bluetooth Low Energy (BLE)

## 🔌 Sensors Used

### 🌫 Gas & Air Quality

* MQ-4 → Methane (CH₄) detection
* MQ-135 → Air quality & harmful gases

### 🌡 Temperature & Environment

* DHT22 → Temperature & humidity
* BME280 → Temperature, humidity, pressure & altitude

### ❤️ Health Monitoring

* MAX30102 → Heart rate & SpO₂
* MLX90614 (GY-906 / HW-691) → Body temperature (infrared)

### 🎯 Motion & Activity

* MPU6050 → Accelerometer & gyroscope (movement / fall detection)

### 🔊 Sound Analysis

* INMP441 → Digital microphone (sound level & frequency analysis)

### 📍 Location

* GPS Module → Real-time location tracking

---

## 📱 Mobile App

This repository contains the mobile application of the SafeVest system.

The app connects to ESP32 via Bluetooth and displays real-time data such as:

* Gas levels
* Temperature & humidity
* Heart rate
* Body temperature
* Motion status
* Sound levels
* GPS location

---

## 🧠 System Architecture

* Sensors collect real-time data via ESP32
* Data is transmitted via BLE
* Mobile app processes and visualizes the data
* Alerts are triggered when thresholds are exceeded

---

## 🎯 Purpose

To improve occupational safety by detecting environmental hazards and monitoring worker health in real-time.

---

## 🔮 Future Improvements

* ☁️ Cloud integration
* 📊 Data logging & analytics
* 🤖 AI-based risk prediction (planned)

---

## ⚙️ Getting Started

```bash
npm install
npm start
npm run android
```

---

## 👩‍💻 Developer

Developed by Irem Nur Celik
