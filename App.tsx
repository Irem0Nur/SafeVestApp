import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ScrollView,
  PermissionsAndroid,
  Platform,
  Alert,
  LogBox,
  ActivityIndicator,
  ImageBackground,
  Linking,
  Animated,
  Image,
} from 'react-native';
import { BleManager, Device, Subscription } from 'react-native-ble-plx';
import { decode as atob } from 'base-64';
import Geolocation from '@react-native-community/geolocation';

LogBox.ignoreAllLogs(true);

type RiskLevel = 'SAFE' | 'WARNING' | 'CRITICAL';
type Screen = 'CONNECT' | 'DASHBOARD' | 'ALERTS' | 'SETTINGS';

type SensorData = {
  workerName: string;
  heartRate: number;
  bodyTemp: number;
  humidity: number;
  ambientTemp: number;
  airQuality: number;
  methane: number;
  noiseDb: number;
  postureOk: boolean;
  fallDetected: boolean;
  shiftMinutes: number;
  lanyardConnected: boolean;
  gpsLat: number;
  gpsLng: number;
  gpsValid: boolean;
  emergencyButton: boolean;
  lowPulseStillAlarm: boolean;
  stillnessActive: boolean;
  connected: boolean;
  deviceName: string;
  lastUpdate: string;
};

const BLE_SERVICE_UUID = '0000FFE0-0000-1000-8000-00805F9B34FB';
const BLE_CHARACTERISTIC_UUID = '0000FFE1-0000-1000-8000-00805F9B34FB';

// Snapshot endpoint
const CAMERA_CAPTURE_BASE_URL = 'http://10.128.184.45/capture';

const COLORS = {
  text: '#F8FAFC',
  sub: '#CBD5E1',
  muted: '#94A3B8',
  glass: 'rgba(15, 23, 42, 0.62)',
  glass2: 'rgba(30, 41, 59, 0.45)',
  border: 'rgba(255,255,255,0.10)',
  safe: '#22C55E',
  warning: '#F59E0B',
  danger: '#EF4444',
  primary: '#3B82F6',
  yellow: '#FFD60A',
  darkBlue: 'rgba(8, 18, 36, 0.70)',
  shadow: 'rgba(0,0,0,0.35)',
};

const initialData: SensorData = {
  workerName: 'Saha Personeli 01',
  heartRate: 0,
  bodyTemp: 0,
  humidity: 0,
  ambientTemp: 0,
  airQuality: 0,
  methane: 0,
  noiseDb: 0,
  postureOk: true,
  fallDetected: false,
  shiftMinutes: 0,
  lanyardConnected: true,
  gpsLat: 0,
  gpsLng: 0,
  gpsValid: false,
  emergencyButton: false,
  lowPulseStillAlarm: false,
  stillnessActive: false,
  connected: false,
  deviceName: 'SAFEVEST_ESP32',
  lastUpdate: '--:--:--',
};

function calculateRisk(data: SensorData): RiskLevel {
  let score = 0;

  if (data.heartRate > 110) score += 18;
  else if (data.heartRate > 95) score += 8;

  if (data.bodyTemp > 37.8) score += 16;
  else if (data.bodyTemp > 37.2) score += 8;

  if (data.airQuality > 900) score += 20;
  else if (data.airQuality > 700) score += 10;

  if (data.methane > 500) score += 24;
  else if (data.methane > 250) score += 10;

  if (data.noiseDb > 85) score += 18;
  else if (data.noiseDb > 45) score += 8;

  if (!data.postureOk) score += 10;
  if (data.fallDetected) score += 35;
  if (data.shiftMinutes >= 120) score += 12;
  if (!data.lanyardConnected) score += 18;
  if (data.lowPulseStillAlarm) score += 20;
  if (data.emergencyButton) score += 25;

  if (score >= 55) return 'CRITICAL';
  if (score >= 25) return 'WARNING';
  return 'SAFE';
}

function getAlerts(data: SensorData): string[] {
  const alerts: string[] = [];

  if (data.noiseDb > 45) {
    alerts.push('45 dB üstü gürültü algılandı. Kulak koruyucu önerilir.');
  }
  if (data.noiseDb > 85) {
    alerts.push('85 dB üstü kritik gürültü. Kulaklık kullanımı zorunlu uyarısı ver.');
  }
  if (data.shiftMinutes >= 120) {
    alerts.push('Zorunlu mola süresi doldu. Çalışana mola bildirimi gönder.');
  }
  if (!data.postureOk) {
    alerts.push('Yanlış duruş algılandı. Postür düzeltme uyarısı göster.');
  }
  if (!data.lanyardConnected) {
    alerts.push('Lanyard bağlantısı doğrulanmadı. Yüksekte çalışma riski var.');
  }
  if (data.methane > 250) {
    alerts.push('Metan seviyesi yükseliyor. Alan havalandırılmalı ve kontrol edilmeli.');
  }
  if (data.airQuality > 700) {
    alerts.push('Hava kalitesi düşüyor. Havalandırma önerilir.');
  }
  if (data.fallDetected) {
    alerts.push('Düşme algılandı. Acil durum süreci başlatılmalı.');
  }
  if (data.lowPulseStillAlarm) {
    alerts.push('Düşük nabız + hareketsizlik alarmı aktif.');
  }
  if (data.emergencyButton) {
    alerts.push('Fiziksel acil durum butonu tetiklendi.');
  }

  return alerts;
}

function riskColor(risk: RiskLevel) {
  switch (risk) {
    case 'CRITICAL':
      return COLORS.danger;
    case 'WARNING':
      return COLORS.warning;
    default:
      return COLORS.safe;
  }
}

function riskLabel(risk: RiskLevel) {
  switch (risk) {
    case 'CRITICAL':
      return 'KRİTİK';
    case 'WARNING':
      return 'DİKKAT';
    default:
      return 'GÜVENLİ';
  }
}

function SensorCard({
  title,
  value,
  unit,
  accent,
}: {
  title: string;
  value: string | number;
  unit?: string;
  accent?: string;
}) {
  return (
    <View style={styles.sensorCard}>
      <View style={[styles.sensorAccent, { backgroundColor: accent || COLORS.primary }]} />
      <Text style={styles.sensorTitle}>{title}</Text>
      <View style={styles.sensorValueRow}>
        <Text style={styles.sensorValue}>{value}</Text>
        {!!unit && <Text style={styles.sensorUnit}>{unit}</Text>}
      </View>
    </View>
  );
}

function StatusMini({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <View style={styles.statusMiniBox}>
      <Text style={styles.statusMiniLabel}>{label}</Text>
      <Text style={[styles.statusMiniValue, { color }]}>{value}</Text>
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.tabButton, active && styles.tabButtonActive]}
      onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('CONNECT');
  const [data, setData] = useState<SensorData>(initialData);
  const [isScanning, setIsScanning] = useState(false);
  const [nearbyDevices, setNearbyDevices] = useState<Device[]>([]);
  const [connectedDeviceId, setConnectedDeviceId] = useState<string | null>(null);

  const [sosActive, setSosActive] = useState(false);
  const [sosLocation, setSosLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [sosTime, setSosTime] = useState<string | null>(null);
  const [gettingLocation, setGettingLocation] = useState(false);

  const [cameraImage, setCameraImage] = useState<string | null>(null);
  const [cameraCapturedAt, setCameraCapturedAt] = useState<string | null>(null);

  const sosPulseAnim = useRef(new Animated.Value(1)).current;

  const managerRef = useRef(new BleManager());
  const monitorRef = useRef<Subscription | null>(null);
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHardwareSosAtRef = useRef(0);

  const risk = useMemo(() => calculateRisk(data), [data]);
  const alerts = useMemo(() => getAlerts(data), [data]);

  useEffect(() => {
    if (sosActive) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(sosPulseAnim, {
            toValue: 1.12,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(sosPulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      sosPulseAnim.setValue(1);
    }
  }, [sosActive, sosPulseAnim]);

  useEffect(() => {
    return () => {
      try {
        monitorRef.current?.remove();
        managerRef.current.stopDeviceScan();
        if (scanTimeoutRef.current) {
          clearTimeout(scanTimeoutRef.current);
        }
        managerRef.current.destroy();
      } catch (e) {
        console.log('Cleanup hatası:', e);
      }
    };
  }, []);

  const requestBlePermissions = async () => {
    if (Platform.OS !== 'android') return true;

    if (Platform.Version >= 31) {
      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);

      return Object.values(results).every(
        value => value === PermissionsAndroid.RESULTS.GRANTED,
      );
    }

    const location = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );

    return location === PermissionsAndroid.RESULTS.GRANTED;
  };

  const requestLocationPermission = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;

    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'Konum İzni Gerekli',
          message: 'SOS acil durum bildirimi için konumunuza erişmemiz gerekiyor.',
          buttonNeutral: 'Sonra Sor',
          buttonNegative: 'İptal',
          buttonPositive: 'İzin Ver',
        },
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch (err) {
      console.log('Konum izni hatası:', err);
      return false;
    }
  };

  const captureCameraImage = () => {
    const imageUrl = `${CAMERA_CAPTURE_BASE_URL}?t=${Date.now()}`;
    const timeStr = new Date().toLocaleTimeString('tr-TR');

    setCameraImage(imageUrl);
    setCameraCapturedAt(timeStr);

    console.log('Kamera snapshot alındı:', imageUrl);
  };

  const activateSosWithCoordinates = (
    latitude: number,
    longitude: number,
    source: 'phone' | 'hardware',
  ) => {
    const timeStr = new Date().toLocaleTimeString('tr-TR');

    setSosLocation({ lat: latitude, lng: longitude });
    setSosTime(timeStr);
    setSosActive(true);
    setGettingLocation(false);

    setData(prev => ({
      ...prev,
      gpsLat: latitude,
      gpsLng: longitude,
      gpsValid: true,
    }));

    captureCameraImage();

    Alert.alert(
      source === 'hardware' ? '🚨 DONANIM SOS AKTİF' : '🚨 SOS AKTİF',
      `Acil durum bildirimi alındı!\n\nKonum: ${latitude.toFixed(6)}, ${longitude.toFixed(
        6,
      )}\nZaman: ${timeStr}`,
      [{ text: 'Tamam' }],
    );
  };

  const handleSOS = async () => {
    if (gettingLocation) return;

    setGettingLocation(true);

    const hasPermission = await requestLocationPermission();
    if (!hasPermission) {
      Alert.alert(
        'Konum İzni Gerekli',
        'SOS bildirimi göndermek için konum izni vermeniz gerekiyor. Lütfen ayarlardan izin verin.',
        [
          { text: 'İptal', style: 'cancel' },
          { text: 'Ayarlara Git', onPress: () => Linking.openSettings() },
        ],
      );
      setGettingLocation(false);
      return;
    }

    Geolocation.getCurrentPosition(
      position => {
        const { latitude, longitude } = position.coords;
        activateSosWithCoordinates(latitude, longitude, 'phone');
      },
      error => {
        console.log('GPS hatası:', error);
        setGettingLocation(false);

        captureCameraImage();

        let errorMsg = 'Konum alınamadı.';
        switch (error.code) {
          case 1:
            errorMsg = 'Konum izni reddedildi. Lütfen ayarlardan izin verin.';
            break;
          case 2:
            errorMsg = 'Konum servisi kullanılamıyor. GPS açık olduğundan emin olun.';
            break;
          case 3:
            errorMsg = 'Konum alınırken zaman aşımı oluştu. Açık alanda tekrar deneyin.';
            break;
        }

        setSosTime(new Date().toLocaleTimeString('tr-TR'));
        setSosActive(true);

        Alert.alert('GPS Hatası', `${errorMsg}\n\nKamera görüntüsü yine de alındı.`);
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 5000,
      },
    );
  };

  const triggerHardwareSOS = (lat?: number, lng?: number, gpsValid?: boolean) => {
    const now = Date.now();

    if (now - lastHardwareSosAtRef.current < 5000) {
      console.log('Donanım SOS cooldown aktif, tekrar tetiklenmedi.');
      return;
    }

    lastHardwareSosAtRef.current = now;
    console.log('Donanımdan SOS tetiklendi.');

    if (gpsValid && typeof lat === 'number' && typeof lng === 'number' && !(lat === 0 && lng === 0)) {
      activateSosWithCoordinates(lat, lng, 'hardware');
      return;
    }

    captureCameraImage();

    const timeStr = new Date().toLocaleTimeString('tr-TR');
    setSosTime(timeStr);
    setSosActive(true);

    Alert.alert(
      '🚨 DONANIM SOS',
      'Fiziksel acil durum butonuna basıldı ancak geçerli GPS verisi henüz alınamadı. Kamera görüntüsü alındı.',
      [{ text: 'Tamam' }],
    );
  };

  const cancelSOS = () => {
    Alert.alert(
      'SOS İptal',
      'Acil durum bildirimini iptal etmek istediğinize emin misiniz?',
      [
        { text: 'Hayır', style: 'cancel' },
        {
          text: 'Evet, İptal Et',
          style: 'destructive',
          onPress: () => {
            setSosActive(false);
            setSosLocation(null);
            setSosTime(null);
          },
        },
      ],
    );
  };

  const parseIncomingJson = (raw: string) => {
    try {
      console.log('GELEN VERI:', raw);

      let parsed: any = null;

      try {
        parsed = JSON.parse(raw);
      } catch {
        const obj: any = {};
        raw.split(',').forEach(part => {
          const [key, value] = part.split(':').map(x => x?.trim());
          if (key && value !== undefined) {
            obj[key] = value;
          }
        });

        if (Object.keys(obj).length > 0) {
          parsed = obj;
        }
      }

      if (!parsed) {
        console.log('Veri çözülemedi:', raw);
        return;
      }

      const nextGpsLat = Number(parsed.gpsLat ?? 0);
      const nextGpsLng = Number(parsed.gpsLng ?? 0);
      const nextGpsValid =
        parsed.gpsValid === true ||
        parsed.gpsValid === 'true' ||
        ((nextGpsLat !== 0 || nextGpsLng !== 0) && !Number.isNaN(nextGpsLat) && !Number.isNaN(nextGpsLng));

      const incomingType = String(parsed.type ?? '').toLowerCase();
      const hasSosEvent =
        parsed.sosEvent === true ||
        parsed.sosEvent === 'true' ||
        parsed.sos === true ||
        parsed.sos === 'true' ||
        incomingType === 'sos';

      setData(prev => ({
        ...prev,
        workerName: parsed.workerName ?? prev.workerName,
        heartRate: Number(parsed.heartRate ?? prev.heartRate),
        bodyTemp: Number(parsed.bodySurfaceTemp ?? parsed.bodyTemp ?? prev.bodyTemp),
        humidity: Number(parsed.humidity ?? prev.humidity),
        ambientTemp: Number(parsed.ambientTemp ?? prev.ambientTemp),
        airQuality: Number(parsed.airQuality ?? prev.airQuality),
        methane: Number(parsed.methane ?? prev.methane),
        noiseDb: Number(parsed.noiseDb ?? prev.noiseDb),
        postureOk:
          parsed.postureOk === undefined
            ? prev.postureOk
            : parsed.postureOk === true || parsed.postureOk === 'true',
        fallDetected:
          parsed.fallDetected === undefined
            ? prev.fallDetected
            : parsed.fallDetected === true || parsed.fallDetected === 'true',
        shiftMinutes: Number(parsed.shiftMinutes ?? prev.shiftMinutes),
        lanyardConnected:
          parsed.lanyardConnected === undefined
            ? prev.lanyardConnected
            : parsed.lanyardConnected === true || parsed.lanyardConnected === 'true',
        gpsLat: !Number.isNaN(nextGpsLat) ? nextGpsLat : prev.gpsLat,
        gpsLng: !Number.isNaN(nextGpsLng) ? nextGpsLng : prev.gpsLng,
        gpsValid: nextGpsValid,
        emergencyButton:
          parsed.emergencyButton === undefined
            ? prev.emergencyButton
            : parsed.emergencyButton === true || parsed.emergencyButton === 'true',
        lowPulseStillAlarm:
          parsed.lowPulseStillAlarm === undefined
            ? prev.lowPulseStillAlarm
            : parsed.lowPulseStillAlarm === true || parsed.lowPulseStillAlarm === 'true',
        stillnessActive:
          parsed.stillnessActive === undefined
            ? prev.stillnessActive
            : parsed.stillnessActive === true || parsed.stillnessActive === 'true',
        connected: true,
        lastUpdate: new Date().toLocaleTimeString('tr-TR'),
      }));

      if (hasSosEvent) {
        triggerHardwareSOS(nextGpsLat, nextGpsLng, nextGpsValid);
      }
    } catch (error) {
      console.log('parseIncomingJson genel hata:', raw, error);
    }
  };

  const startScan = async () => {
    const granted = await requestBlePermissions();

    if (!granted) {
      Alert.alert('İzin gerekli', 'BLE taraması için gerekli izinler verilmedi.');
      return;
    }

    try {
      managerRef.current.stopDeviceScan();
      if (scanTimeoutRef.current) {
        clearTimeout(scanTimeoutRef.current);
      }

      setNearbyDevices([]);
      setIsScanning(true);

      managerRef.current.startDeviceScan(null, null, (error, device) => {
        if (error) {
          console.log('Scan hatası:', JSON.stringify(error, null, 2));
          setIsScanning(false);
          return;
        }

        const rawName = device?.name || device?.localName || '';
        const deviceName = rawName.toUpperCase();
        const hasTargetName =
          deviceName.includes('SAFEVEST') || deviceName.includes('ESP32');

        console.log('Taranan cihaz:', {
          id: device?.id,
          name: device?.name,
          localName: device?.localName,
          hasTargetName,
        });

        if (device && hasTargetName) {
          setNearbyDevices(prev => {
            if (prev.some(item => item.id === device.id)) return prev;
            return [...prev, device];
          });
        }
      });

      scanTimeoutRef.current = setTimeout(() => {
        try {
          managerRef.current.stopDeviceScan();
        } catch (e) {
          console.log('Scan stop hatası:', e);
        }
        setIsScanning(false);
      }, 10000);
    } catch (e) {
      console.log('Tarama başlatma hatası:', e);
      setIsScanning(false);
      Alert.alert('Hata', 'BLE taraması başlatılamadı.');
    }
  };

  const connectToDevice = async (device: Device) => {
    try {
      console.log('Bağlanılacak cihaz:', {
        id: device.id,
        name: device.name,
        localName: device.localName,
      });

      managerRef.current.stopDeviceScan();
      if (scanTimeoutRef.current) {
        clearTimeout(scanTimeoutRef.current);
      }
      setIsScanning(false);

      const connected = await device.connect();
      console.log('Cihaz bağlandı:', connected.id);

      await connected.discoverAllServicesAndCharacteristics();
      console.log('Servisler ve karakteristikler keşfedildi');

      if (Platform.OS === 'android') {
        try {
          await connected.requestMTU(512);
          console.log('MTU 512 olarak ayarlandı.');
        } catch (mtuError) {
          console.log('MTU ayarlanamadı, varsayılan kullanılacak:', mtuError);
        }
      }

      setConnectedDeviceId(connected.id);
      setData(prev => ({
        ...prev,
        connected: true,
        deviceName: connected.name || connected.localName || 'SAFEVEST_ESP32',
        lastUpdate: new Date().toLocaleTimeString('tr-TR'),
      }));

      monitorRef.current?.remove();

      monitorRef.current = managerRef.current.monitorCharacteristicForDevice(
        connected.id,
        BLE_SERVICE_UUID,
        BLE_CHARACTERISTIC_UUID,
        (error, characteristic) => {
          if (error) {
            console.log('Monitor hatası:', JSON.stringify(error, null, 2));
            return;
          }

          if (!characteristic || !characteristic.value) {
            console.log('Characteristic boş geldi');
            return;
          }

          try {
            const decoded = atob(characteristic.value);
            console.log('BLE RAW BASE64:', characteristic.value);
            console.log('BLE DECODED:', decoded);
            parseIncomingJson(decoded);
          } catch (decodeError) {
            console.log('Base64 decode hatası:', decodeError);
            console.log('Gelen raw characteristic:', characteristic.value);
          }
        },
      );

      setScreen('DASHBOARD');
    } catch (error) {
      console.log('Bağlantı hatası:', error);
      Alert.alert('Bağlantı hatası', 'ESP32 cihazına bağlanılamadı.');
    }
  };

  const disconnectDevice = async () => {
    try {
      monitorRef.current?.remove();
      monitorRef.current = null;

      if (connectedDeviceId) {
        await managerRef.current.cancelDeviceConnection(connectedDeviceId);
      }
    } catch (error) {
      console.log('Ayrılma hatası:', error);
    } finally {
      setConnectedDeviceId(null);
      setScreen('CONNECT');
      setData({
        ...initialData,
        lastUpdate: '--:--:--',
      });
      setSosActive(false);
      setSosLocation(null);
      setSosTime(null);
      setCameraImage(null);
      setCameraCapturedAt(null);
    }
  };

  return (
    <ImageBackground
      source={require('./assets/bg.png')}
      style={styles.background}
      resizeMode="cover"
      blurRadius={1}>
      <View style={styles.overlay}>
        <SafeAreaView style={styles.container}>
          <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}>
            <View style={styles.headerHero}>
              <View style={styles.headerGlow} />
              <View style={{ flex: 1 }}>
                <Text style={styles.brand}>🦺 SAFEVEST AI</Text>
                <Text style={styles.brandSub}>İSG Canlı Takip ve Erken Uyarı Sistemi</Text>
                <Text style={styles.brandMini}>
                  Akıllı Yelek • BLE İzleme • Risk Analizi
                </Text>
              </View>

              <View style={[styles.riskPill, { backgroundColor: riskColor(risk) }]}>
                <Text style={styles.riskPillText}>{riskLabel(risk)}</Text>
              </View>
            </View>

            <View style={styles.tabRow}>
              <TabButton
                label="BAĞLANTI"
                active={screen === 'CONNECT'}
                onPress={() => setScreen('CONNECT')}
              />
              <TabButton
                label="PANEL"
                active={screen === 'DASHBOARD'}
                onPress={() => setScreen('DASHBOARD')}
              />
              <TabButton
                label="UYARILAR"
                active={screen === 'ALERTS'}
                onPress={() => setScreen('ALERTS')}
              />
              <TabButton
                label="AYARLAR"
                active={screen === 'SETTINGS'}
                onPress={() => setScreen('SETTINGS')}
              />
            </View>

            {screen === 'CONNECT' && (
              <>
                <View style={styles.heroCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.heroTitle}>Cihaz Bağlantısı</Text>
                    <Text style={styles.heroText}>BLE ile yeleği tara, seç ve bağlan.</Text>
                    <Text style={styles.heroMini}>Servis: 0000FFE0...</Text>
                    <Text style={styles.heroMini}>Karakteristik: 0000FFE1...</Text>
                  </View>

                  <View
                    style={[
                      styles.miniBadge,
                      { backgroundColor: data.connected ? COLORS.safe : COLORS.warning },
                    ]}>
                    <Text style={styles.miniBadgeText}>
                      {data.connected ? 'BAĞLI' : 'PASİF'}
                    </Text>
                  </View>
                </View>

                <View style={styles.glassCard}>
                  <Text style={styles.cardTitle}>Bağlantı Durumu</Text>
                  <Text style={styles.cardText}>Cihaz: {data.deviceName}</Text>
                  <Text style={styles.cardText}>
                    Durum: {data.connected ? 'Aktif bağlantı var' : 'Henüz bağlı değil'}
                  </Text>
                  <Text style={styles.cardText}>Son güncelleme: {data.lastUpdate}</Text>

                  <TouchableOpacity style={styles.primaryButton} onPress={startScan}>
                    <Text style={styles.primaryButtonText}>
                      {isScanning ? 'TARANIYOR...' : 'CİHAZ TARA'}
                    </Text>
                  </TouchableOpacity>

                  {data.connected && (
                    <TouchableOpacity style={styles.dangerButton} onPress={disconnectDevice}>
                      <Text style={styles.primaryButtonText}>BAĞLANTIYI KES</Text>
                    </TouchableOpacity>
                  )}

                  {isScanning && (
                    <View style={styles.scanRow}>
                      <ActivityIndicator color={COLORS.yellow} />
                      <Text style={styles.scanText}>Yakındaki BLE cihazları aranıyor...</Text>
                    </View>
                  )}
                </View>

                <View style={styles.glassCard}>
                  <Text style={styles.cardTitle}>Bulunan Cihazlar</Text>

                  {nearbyDevices.length === 0 ? (
                    <Text style={styles.cardText}>
                      Tarama sonrası bulunan SAFEVEST / ESP32 cihazları burada listelenecek.
                    </Text>
                  ) : (
                    nearbyDevices.map(device => (
                      <TouchableOpacity
                        key={device.id}
                        style={styles.deviceCard}
                        onPress={() => connectToDevice(device)}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.deviceName}>
                            {device.name || device.localName || 'İsimsiz cihaz'}
                          </Text>
                          <Text style={styles.deviceId}>{device.id}</Text>
                        </View>
                        <Text style={styles.deviceAction}>BAĞLAN</Text>
                      </TouchableOpacity>
                    ))
                  )}
                </View>
              </>
            )}

            {screen === 'DASHBOARD' && (
              <>
                <View style={styles.dashboardHero}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.dashboardHeroTitle}>Canlı Saha Durumu</Text>
                    <Text style={styles.dashboardHeroText}>Personel: {data.workerName}</Text>
                    <Text style={styles.dashboardHeroText}>Cihaz: {data.deviceName}</Text>
                    <Text style={styles.dashboardHeroText}>Son veri: {data.lastUpdate}</Text>
                  </View>

                  <View
                    style={[
                      styles.riskCircle,
                      { borderColor: riskColor(risk), shadowColor: riskColor(risk) },
                    ]}>
                    <Text style={[styles.riskCircleText, { color: riskColor(risk) }]}>
                      {riskLabel(risk)}
                    </Text>
                  </View>
                </View>

                <View style={styles.sensorGrid}>
                  <SensorCard
                    title="Nabız"
                    value={data.heartRate}
                    unit="BPM"
                    accent="#EF4444"
                  />
                  <SensorCard
                    title="Ortam Sıcaklığı"
                    value={data.ambientTemp.toFixed(1)}
                    unit="°C"
                    accent="#F59E0B"
                  />
                  <SensorCard
                    title="Vücut Sıcaklığı"
                    value={data.bodyTemp.toFixed(1)}
                    unit="°C"
                    accent="#FF3B30"
                  />
                  <SensorCard
                    title="Metan"
                    value={data.methane}
                    unit="ppm"
                    accent="#22C55E"
                  />
                  <SensorCard
                    title="Hava Kalitesi"
                    value={data.airQuality}
                    accent="#3B82F6"
                  />
                  <SensorCard
                    title="Nem"
                    value={data.humidity}
                    unit="%"
                    accent="#06B6D4"
                  />
                </View>

                <View style={styles.glassCard}>
                  <Text style={styles.cardTitle}>Güvenlik Kontrolleri</Text>

                  <View style={styles.statusRow}>
                    <StatusMini
                      label="Postür"
                      value={data.postureOk ? 'Doğru' : 'Hatalı'}
                      color={data.postureOk ? COLORS.safe : COLORS.warning}
                    />
                    <StatusMini
                      label="Düşme"
                      value={data.fallDetected ? 'Algılandı' : 'Yok'}
                      color={data.fallDetected ? COLORS.danger : COLORS.safe}
                    />
                  </View>

                  <View style={styles.statusRow}>
                    <StatusMini
                      label="Lanyard"
                      value={data.lanyardConnected ? 'Bağlı' : 'Bağlı değil'}
                      color={data.lanyardConnected ? COLORS.safe : COLORS.danger}
                    />
                    <StatusMini
                      label="Mola Süresi"
                      value={`${data.shiftMinutes} dk`}
                      color={data.shiftMinutes >= 120 ? COLORS.warning : COLORS.text}
                    />
                  </View>

                  <View style={styles.statusRow}>
                    <StatusMini
                      label="GPS"
                      value={
                        data.gpsValid
                          ? `${data.gpsLat.toFixed(6)}, ${data.gpsLng.toFixed(6)}`
                          : 'GPS yok'
                      }
                      color={data.gpsValid ? COLORS.text : COLORS.warning}
                    />
                  </View>

                  <View style={styles.statusRow}>
                    <StatusMini
                      label="Acil Buton"
                      value={data.emergencyButton ? 'Basılı / Tetiklendi' : 'Normal'}
                      color={data.emergencyButton ? COLORS.danger : COLORS.safe}
                    />
                    <StatusMini
                      label="Düşük Nabız+Sabit"
                      value={data.lowPulseStillAlarm ? 'Alarm' : 'Normal'}
                      color={data.lowPulseStillAlarm ? COLORS.danger : COLORS.safe}
                    />
                  </View>
                </View>

                <View style={styles.sosSection}>
                  {sosActive && (
                    <View style={styles.sosInfoCard}>
                      <View style={styles.sosInfoHeader}>
                        <Text style={styles.sosInfoIcon}>🚨</Text>
                        <Text style={styles.sosInfoTitle}>SOS AKTİF</Text>
                      </View>

                      {sosLocation ? (
                        <>
                          <View style={styles.sosInfoRow}>
                            <Text style={styles.sosInfoLabel}>Enlem:</Text>
                            <Text style={styles.sosInfoValue}>{sosLocation.lat.toFixed(6)}</Text>
                          </View>
                          <View style={styles.sosInfoRow}>
                            <Text style={styles.sosInfoLabel}>Boylam:</Text>
                            <Text style={styles.sosInfoValue}>{sosLocation.lng.toFixed(6)}</Text>
                          </View>
                        </>
                      ) : (
                        <View style={styles.sosInfoRow}>
                          <Text style={styles.sosInfoLabel}>Konum:</Text>
                          <Text style={styles.sosInfoValue}>GPS henüz yok</Text>
                        </View>
                      )}

                      <View style={styles.sosInfoRow}>
                        <Text style={styles.sosInfoLabel}>Zaman:</Text>
                        <Text style={styles.sosInfoValue}>{sosTime}</Text>
                      </View>

                      {cameraCapturedAt && (
                        <View style={styles.sosInfoRow}>
                          <Text style={styles.sosInfoLabel}>Kamera:</Text>
                          <Text style={styles.sosInfoValue}>{cameraCapturedAt}</Text>
                        </View>
                      )}

                      <TouchableOpacity style={styles.sosCancelButton} onPress={cancelSOS}>
                        <Text style={styles.sosCancelButtonText}>SOS İPTAL ET</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  <Animated.View style={{ transform: [{ scale: sosPulseAnim }] }}>
                    <TouchableOpacity
                      style={[
                        styles.sosButton,
                        sosActive && styles.sosButtonActive,
                        gettingLocation && styles.sosButtonLoading,
                      ]}
                      onPress={sosActive ? cancelSOS : handleSOS}
                      activeOpacity={0.7}
                      disabled={gettingLocation}>
                      {gettingLocation ? (
                        <>
                          <ActivityIndicator color="#fff" size="large" />
                          <Text style={styles.sosButtonText}>KONUM ALINIYOR...</Text>
                        </>
                      ) : (
                        <>
                          <Text style={styles.sosButtonIcon}>{sosActive ? '✅' : '🆘'}</Text>
                          <Text style={styles.sosButtonText}>
                            {sosActive ? 'SOS AKTİF — İPTAL ET' : 'SOS ACİL DURUM'}
                          </Text>
                          <Text style={styles.sosButtonSub}>
                            {sosActive
                              ? 'Acil durum bildirimi aktif'
                              : 'Basınca telefon konumu alınır ve anlık kamera görüntüsü çekilir'}
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </Animated.View>
                </View>
              </>
            )}

            {screen === 'ALERTS' && (
              <View style={styles.glassCard}>
                <Text style={styles.cardTitle}>Aktif Uyarılar</Text>

                {alerts.length === 0 ? (
                  <View style={styles.emptyAlert}>
                    <Text style={styles.emptyAlertIcon}>✅</Text>
                    <Text style={styles.emptyAlertText}>Şu an aktif kritik uyarı yok.</Text>
                  </View>
                ) : (
                  alerts.map((item, index) => (
                    <View key={index} style={styles.alertCard}>
                      <View style={styles.alertTop}>
                        <Text style={styles.alertTitle}>UYARI {index + 1}</Text>
                        <View style={styles.alertTag}>
                          <Text style={styles.alertTagText}>İSG</Text>
                        </View>
                      </View>
                      <Text style={styles.alertText}>{item}</Text>
                    </View>
                  ))
                )}
              </View>
            )}

            {screen === 'SETTINGS' && (
              <>
                <View style={styles.glassCard}>
                  <Text style={styles.cardTitle}>Kural Eşikleri</Text>
                  <Text style={styles.cardText}>• 45 dB üstü: Kulak koruyucu önerisi</Text>
                  <Text style={styles.cardText}>• 85 dB üstü: Kritik gürültü alarmı</Text>
                  <Text style={styles.cardText}>• 120 dakika: Zorunlu mola bildirimi</Text>
                  <Text style={styles.cardText}>• Metan {'>'} 500 ppm: Kritik gaz alarmı</Text>
                  <Text style={styles.cardText}>• Düşme: Acil durum uyarısı</Text>
                  <Text style={styles.cardText}>• Lanyard yoksa: Yüksekte çalışma uyarısı</Text>
                  <Text style={styles.cardText}>• type:"sos" veya sosEvent:true gelirse donanım SOS tetiklenir</Text>
                </View>

                <View style={styles.glassCard}>
                  <Text style={styles.cardTitle}>SOS Kamera Görüntüsü</Text>
                  {cameraImage ? (
                    <>
                      <Text style={styles.cardText}>
                        Son görüntü {cameraCapturedAt ?? '--:--:--'} saatinde alındı.
                      </Text>
                      <Image
                        source={{ uri: cameraImage }}
                        style={styles.cameraImage}
                        resizeMode="cover"
                      />
                    </>
                  ) : (
                    <Text style={styles.cardText}>
                      SOS butonuna basıldığında anlık kamera görüntüsü burada görünecek.
                    </Text>
                  )}
                </View>

                <View style={styles.glassCard}>
                  <Text style={styles.cardTitle}>ESP32 JSON Formatı</Text>
                  <Text style={styles.codeBlock}>{`{
  "type":"sos",
  "sosEvent":true,
  "heartRate":96,
  "bodyTemp":36.8,
  "bodySurfaceTemp":36.8,
  "humidity":58,
  "ambientTemp":29,
  "airQuality":610,
  "methane":180,
  "noiseDb":0,
  "postureOk":true,
  "fallDetected":false,
  "emergencyButton":true,
  "lowPulseStillAlarm":false,
  "stillnessActive":false,
  "shiftMinutes":95,
  "lanyardConnected":true,
  "gpsValid":true,
  "gpsLat":38.423700,
  "gpsLng":27.142800
}`}</Text>
                </View>
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </View>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  background: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    backgroundColor: COLORS.darkBlue,
  },
  container: {
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 40,
  },
  scrollContent: {
    paddingBottom: 34,
  },

  headerHero: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: 'rgba(10, 16, 28, 0.72)',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 28,
    padding: 20,
    marginBottom: 18,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  headerGlow: {
    position: 'absolute',
    right: -20,
    top: -20,
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255, 214, 10, 0.14)',
  },
  brand: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '900',
  },
  brandSub: {
    color: COLORS.sub,
    fontSize: 14,
    marginTop: 8,
    fontWeight: '700',
  },
  brandMini: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 8,
  },
  riskPill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    alignSelf: 'flex-start',
  },
  riskPillText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 12,
  },

  tabRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 18,
  },
  tabButton: {
    flex: 1,
    backgroundColor: COLORS.glass2,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 18,
    paddingVertical: 13,
    alignItems: 'center',
  },
  tabButtonActive: {
    backgroundColor: COLORS.yellow,
  },
  tabText: {
    color: COLORS.text,
    fontWeight: '800',
    fontSize: 12,
  },
  tabTextActive: {
    color: '#111827',
  },

  heroCard: {
    backgroundColor: COLORS.glass,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 24,
    padding: 18,
    marginBottom: 16,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  heroTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
  },
  heroText: {
    color: COLORS.sub,
    marginTop: 8,
    lineHeight: 20,
  },
  heroMini: {
    color: COLORS.muted,
    marginTop: 6,
    fontSize: 12,
  },
  miniBadge: {
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  miniBadgeText: {
    color: '#111827',
    fontWeight: '900',
    fontSize: 12,
  },

  glassCard: {
    backgroundColor: COLORS.glass,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 24,
    padding: 18,
    marginBottom: 16,
  },
  cardTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '900',
    marginBottom: 12,
  },
  cardText: {
    color: COLORS.sub,
    fontSize: 13,
    lineHeight: 22,
    marginBottom: 8,
  },

  primaryButton: {
    marginTop: 14,
    backgroundColor: COLORS.primary,
    borderRadius: 20,
    paddingVertical: 16,
    alignItems: 'center',
  },
  dangerButton: {
    marginTop: 10,
    backgroundColor: COLORS.danger,
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 15,
  },
  scanRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  scanText: {
    color: COLORS.sub,
  },

  deviceCard: {
    marginTop: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 18,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  deviceName: {
    color: COLORS.text,
    fontWeight: '800',
    fontSize: 15,
  },
  deviceId: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 4,
  },
  deviceAction: {
    color: COLORS.yellow,
    fontWeight: '900',
    fontSize: 12,
  },

  dashboardHero: {
    backgroundColor: COLORS.glass,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 26,
    padding: 18,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  dashboardHeroTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
    marginBottom: 10,
  },
  dashboardHeroText: {
    color: COLORS.sub,
    fontSize: 13,
    marginBottom: 6,
  },
  riskCircle: {
    width: 112,
    height: 112,
    borderRadius: 56,
    borderWidth: 5,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 5,
  },
  riskCircleText: {
    fontSize: 18,
    fontWeight: '900',
  },

  sensorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  sensorCard: {
    width: '48%',
    backgroundColor: COLORS.glass,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 22,
    padding: 16,
    marginBottom: 14,
    overflow: 'hidden',
  },
  sensorAccent: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 6,
    height: '100%',
  },
  sensorTitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginBottom: 10,
    marginLeft: 4,
  },
  sensorValueRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    marginLeft: 4,
  },
  sensorValue: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: '900',
  },
  sensorUnit: {
    color: COLORS.sub,
    fontSize: 12,
    marginBottom: 4,
  },

  statusRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  statusMiniBox: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 14,
  },
  statusMiniLabel: {
    color: COLORS.muted,
    fontSize: 12,
    marginBottom: 8,
  },
  statusMiniValue: {
    fontSize: 15,
    fontWeight: '900',
  },

  emptyAlert: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  emptyAlertIcon: {
    fontSize: 32,
    marginBottom: 10,
  },
  emptyAlertText: {
    color: COLORS.text,
    fontWeight: '800',
  },
  alertCard: {
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderLeftWidth: 4,
    borderLeftColor: COLORS.warning,
    borderRadius: 16,
    padding: 14,
    marginTop: 10,
  },
  alertTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  alertTitle: {
    color: COLORS.text,
    fontWeight: '900',
  },
  alertTag: {
    backgroundColor: COLORS.danger,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  alertTagText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '900',
  },
  alertText: {
    color: '#FDE68A',
    lineHeight: 20,
  },

  codeBlock: {
    color: '#86EFAC',
    fontFamily: 'monospace',
    backgroundColor: 'rgba(0,0,0,0.28)',
    padding: 14,
    borderRadius: 16,
    marginTop: 8,
  },

  cameraImage: {
    width: '100%',
    height: 240,
    borderRadius: 16,
    marginTop: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },

  sosSection: {
    marginTop: 8,
  },
  sosButton: {
    backgroundColor: '#DC2626',
    borderRadius: 28,
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
    elevation: 10,
    borderWidth: 2,
    borderColor: 'rgba(239, 68, 68, 0.5)',
  },
  sosButtonActive: {
    backgroundColor: '#16A34A',
    borderColor: 'rgba(34, 197, 94, 0.5)',
    shadowColor: '#22C55E',
  },
  sosButtonLoading: {
    backgroundColor: '#D97706',
    borderColor: 'rgba(245, 158, 11, 0.5)',
    shadowColor: '#F59E0B',
  },
  sosButtonIcon: {
    fontSize: 36,
    marginBottom: 8,
  },
  sosButtonText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1,
  },
  sosButtonSub: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 12,
    marginTop: 6,
    textAlign: 'center',
  },
  sosInfoCard: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 22,
    padding: 16,
    marginBottom: 14,
  },
  sosInfoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sosInfoIcon: {
    fontSize: 22,
  },
  sosInfoTitle: {
    color: '#EF4444',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 1,
  },
  sosInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  sosInfoLabel: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  sosInfoValue: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  sosCancelButton: {
    marginTop: 12,
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  sosCancelButtonText: {
    color: '#FCA5A5',
    fontWeight: '900',
    fontSize: 13,
  },
});

export default App;