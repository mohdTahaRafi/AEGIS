import { describe, expect, it } from 'vitest';
import { verhoeffGenerate } from '../src/checksums/verhoeff';
import { gstinCheckChar } from '../src/checksums/gstin';
import { aadhaarRecognizer } from '../src/patterns/aadhaar';
import { panRecognizer } from '../src/patterns/pan';
import { gstinRecognizer } from '../src/patterns/gstin';
import { ifscRecognizer } from '../src/patterns/ifsc';
import { upiRecognizer } from '../src/patterns/upi';
import { cardRecognizer } from '../src/patterns/card';
import { phoneRecognizer } from '../src/patterns/phone';
import { emailRecognizer } from '../src/patterns/email';
import { passportRecognizer } from '../src/patterns/passport';
import { vehicleRecognizer } from '../src/patterns/vehicle';
import { pinRecognizer } from '../src/patterns/pin';
import { dobRecognizer } from '../src/patterns/dob';
import { secretRecognizer } from '../src/patterns/secret';

function validAadhaar(seed: number): string {
  const body = String(200000000000 + seed).slice(0, 11);
  return body + verhoeffGenerate(body);
}
function validGstin(seed: number): string {
  const body = `${18 + (seed % 20)}AAAAA${(1000 + seed) % 10000}A1Z`.padEnd(14, '0').slice(0, 14);
  return body + gstinCheckChar(body);
}

describe('aadhaarRecognizer', () => {
  const positives = Array.from({ length: 10 }, (_, i) => validAadhaar(i * 7));
  it.each(positives)('detects valid Aadhaar %s with high, valid score', (digits) => {
    const [m] = aadhaarRecognizer.find(digits);
    expect(m?.valid).toBe(true);
    expect(m?.score).toBeGreaterThanOrEqual(0.95);
  });

  const negatives = ['parcel tracking 234567890123 arrived', '123456789012 order id', 'invoice 987654321098 total'];
  it.each(negatives)('scores %s low (checksum invalid) without context', (text) => {
    const matches = aadhaarRecognizer.find(text);
    for (const m of matches) expect(m.score).toBeLessThanOrEqual(0.6);
  });
});

describe('panRecognizer', () => {
  const positives = ['ABCPD1234E', 'XYZFG5678H', 'PQRTL0001A', 'LMNAB2222C'];
  it.each(positives)('detects PAN-shaped %s', (pan) => {
    expect(panRecognizer.find(pan)).toHaveLength(1);
  });
  const negatives = ['ABCDE1234F', 'PRODUCT1234X', '1234567890', 'ZZZZZ0000Z'];
  it.each(negatives)('rejects non-holder-type shape %s', (text) => {
    expect(panRecognizer.find(text)).toHaveLength(0);
  });
});

describe('gstinRecognizer', () => {
  const positives = Array.from({ length: 10 }, (_, i) => validGstin(i));
  it.each(positives)('validates generated GSTIN %s', (g) => {
    const [m] = gstinRecognizer.find(g);
    expect(m?.valid).toBe(true);
  });
  it('flags a corrupted check char as invalid but still matched', () => {
    const g = validGstin(3);
    const corrupted = g.slice(0, 14) + (g[14] === '0' ? '1' : '0');
    const [m] = gstinRecognizer.find(corrupted);
    expect(m?.valid).toBe(false);
    expect(m!.score).toBeLessThan(0.5);
  });
});

describe('ifscRecognizer', () => {
  it.each(['HDFC0001234', 'SBIN0000456', 'ICIC0ABC123'])('detects IFSC %s', (code) => {
    expect(ifscRecognizer.find(code)).toHaveLength(1);
  });
  it.each(['HDFC1001234', 'AB0001234', 'hdfc0001234'])('rejects malformed %s', (code) => {
    expect(ifscRecognizer.find(code)).toHaveLength(0);
  });
});

describe('upiRecognizer', () => {
  it.each(['john@okhdfcbank', 'priya123@ybl', 'store@paytm'])('detects VPA %s', (vpa) => {
    expect(upiRecognizer.find(vpa)).toHaveLength(1);
  });
  it('does not match a real email address (has a TLD)', () => {
    expect(upiRecognizer.find('john@example.com')).toHaveLength(0);
  });
});

describe('cardRecognizer', () => {
  it.each(['4111111111111111', '4111 1111 1111 1111', '5500000000000004'])('detects valid card %s', (num) => {
    const [m] = cardRecognizer.find(num);
    expect(m?.valid).toBe(true);
  });
  it.each(['1234567890123456', '9999999999999999999'])('scores invalid-Luhn %s as low, non-valid', (num) => {
    const matches = cardRecognizer.find(num);
    for (const m of matches) {
      expect(m.valid).toBe(false);
      expect(m.score).toBeLessThanOrEqual(0.1);
    }
  });
});

describe('phoneRecognizer', () => {
  it.each(['9876543210', '+919876543210', '09876543210'])('detects Indian mobile %s', (num) => {
    expect(phoneRecognizer.find(num).length).toBeGreaterThan(0);
  });
  it('detects an international number with a matching country length', () => {
    expect(phoneRecognizer.find('+44 2079460958').length).toBeGreaterThan(0);
  });
  it.each(['1234567890', '5555555555'])('does not treat a non-[6-9]-leading 10-digit run as Indian mobile %s', (num) => {
    expect(phoneRecognizer.find(num)).toHaveLength(0);
  });
});

describe('emailRecognizer', () => {
  it.each(['a@b.com', 'first.last+tag@sub.example.co.in'])('detects email %s', (e) => {
    expect(emailRecognizer.find(e)).toHaveLength(1);
  });
  it.each(['not-an-email', 'a@b'])('rejects %s', (e) => {
    expect(emailRecognizer.find(e)).toHaveLength(0);
  });
});

describe('passportRecognizer — context changes the score, not the match (T-3.3)', () => {
  it('scores 0.30 without context', () => {
    const [m] = passportRecognizer.find('J1234567');
    expect(m?.score).toBe(0.3);
  });
  it('scores 0.85 with a "Passport number" label', () => {
    const [m] = passportRecognizer.find('J1234567', { label: 'Passport number' });
    expect(m?.score).toBe(0.85);
  });
});

describe('vehicleRecognizer', () => {
  it.each(['MH12AB1234', 'KA05MZ9999', 'DL03CA1234'])('detects registration %s', (v) => {
    expect(vehicleRecognizer.find(v).length).toBeGreaterThan(0);
  });
  it('rejects an unknown state code', () => {
    expect(vehicleRecognizer.find('ZZ12AB1234')).toHaveLength(0);
  });
});

describe('pinRecognizer', () => {
  it('scores low without address context', () => {
    const [m] = pinRecognizer.find('560001');
    expect(m?.score).toBe(0.2);
  });
  it('scores high with address context', () => {
    const [m] = pinRecognizer.find('560001', { label: 'Address / PIN code' });
    expect(m?.score).toBe(0.7);
  });
});

describe('dobRecognizer', () => {
  it('scores low without birth-date context', () => {
    const [m] = dobRecognizer.find('12/05/1990');
    expect(m?.score).toBe(0.3);
  });
  it('scores high with a DOB label', () => {
    const [m] = dobRecognizer.find('12/05/1990', { label: 'Date of birth' });
    expect(m?.score).toBe(0.85);
  });
});

describe('secretRecognizer', () => {
  it('detects a GitHub-shaped token', () => {
    expect(secretRecognizer.find('ghp_' + 'a'.repeat(36)).length).toBeGreaterThan(0);
  });
  it('detects a JWT-shaped string', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PYE1sBTeuf1c';
    expect(secretRecognizer.find(jwt).length).toBeGreaterThan(0);
  });
  it('does not flag ordinary prose as a secret', () => {
    expect(secretRecognizer.find('please log in and submit the form')).toHaveLength(0);
  });
});
