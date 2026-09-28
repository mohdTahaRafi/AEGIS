import { describe, expect, it } from 'vitest';
import { fieldEntitiesFromText, identifierToWords } from '../src/context/field-labels';

describe('fieldEntitiesFromText — one entity per real-world label', () => {
  it.each([
    ['Email ID', 'EMAIL'],
    ['E-mail Address', 'EMAIL'],
    ['Enter your email', 'EMAIL'],
    ['Mobile Number', 'PHONE'],
    ['Mobile No.', 'PHONE'],
    ['Phone', 'PHONE'],
    ['Contact Number', 'PHONE'],
    ['Password', 'PASSWORD'],
    ['Confirm Password', 'PASSWORD'],
    ['Security PIN', 'PASSWORD'],
    ['MPIN', 'PASSWORD'],
    ['UPI PIN', 'PASSWORD'],
    ['OTP', 'OTP'],
    ['One Time Password', 'OTP'],
    ['Enter verification code', 'OTP'],
    ['Aadhaar', 'AADHAAR'],
    ['Aadhaar Card Number', 'AADHAAR'],
    ['Aadhar No.', 'AADHAAR'],
    ['PAN Card Number', 'PAN'],
    ['Permanent Account Number', 'PAN'],
    ['Card Number', 'CARD_NUMBER'],
    ['Debit Card', 'CARD_NUMBER'],
    ['CVV', 'CARD_CVV'],
    ['Card Expiry', 'CARD_EXPIRY'],
    ['Expiry (MM/YY)', 'CARD_EXPIRY'],
    ['Account Number', 'BANK_ACCOUNT'],
    ['IFSC Code', 'IFSC'],
    ['UPI ID', 'UPI_VPA'],
    ['Passport Number', 'PASSPORT'],
    ['Date of Birth', 'DOB'],
    ['DOB', 'DOB'],
    ['Username', 'USERNAME'],
    ['User ID', 'USERNAME'],
    ['Login ID', 'USERNAME'],
    ['Full Name', 'PERSON_NAME'],
    ['First Name', 'PERSON_NAME'],
    ["Father's Name", 'PERSON_NAME'],
    ['Name', 'PERSON_NAME'],
    ['Address Line 1', 'ADDRESS'],
    ['Pincode', 'PIN_CODE'],
    ['GSTIN', 'GSTIN'],
    ['ईमेल', 'EMAIL'],
    ['मोबाइल नंबर', 'PHONE'],
    ['पासवर्ड', 'PASSWORD'],
    ['आधार संख्या', 'AADHAAR'],
  ])('%s → %s', (label, entity) => {
    expect(fieldEntitiesFromText(label)[0]).toBe(entity);
  });
});

describe('fieldEntitiesFromText — hard negatives: a shared word is not a shared meaning', () => {
  it.each([
    ['Email Address', ['EMAIL']],
    ['Aadhaar Card Number', ['AADHAAR']],
    ['PAN Card No', ['PAN']],
    ['Credit Card Expiry', ['CARD_EXPIRY']],
    ['One-time password', ['OTP']],
    ['UPI PIN', ['PASSWORD']],
    ['Permanent Account Number (PAN)', ['PAN']],
    ['User Name', ['USERNAME']],
  ])('%s → exactly %j', (label, entities) => {
    expect(fieldEntitiesFromText(label)).toEqual(entities);
  });

  it.each(['Search', 'Remarks', 'Company Name', 'Name of the Bank', 'Type of Passport', 'Quantity', 'Captcha', 'City', 'Gmail', 'iPhone model', ''])(
    '%j names no sensitive entity',
    (label) => {
      expect(fieldEntitiesFromText(label)).toEqual([]);
    },
  );
});

describe('fieldEntitiesFromText — combined labels keep every entity, in text order', () => {
  it.each([
    ['Email / Mobile Number', ['EMAIL', 'PHONE']],
    ['Mobile number or Email ID', ['PHONE', 'EMAIL']],
    ['Username or email', ['USERNAME', 'EMAIL']],
    ['Name as per Aadhaar', ['PERSON_NAME', 'AADHAAR']],
  ])('%s → %j', (label, entities) => {
    expect(fieldEntitiesFromText(label)).toEqual(entities);
  });
});

describe('identifierToWords', () => {
  it.each([
    ['txtEmailId', 'txt Email Id'],
    ['ctl00$Main$mobile_no', 'ctl00 Main mobile no'],
    ['applicantFirstName', 'applicant First Name'],
    ['user-name', 'user name'],
    ['DOBDate', 'DOB Date'],
  ])('%s → %s', (id, words) => {
    expect(identifierToWords(id)).toBe(words);
  });

  it.each([
    ['txtEmailId', 'EMAIL'],
    ['mobileNo', 'PHONE'],
    ['emailid', 'EMAIL'],
    ['pwd', 'PASSWORD'],
    ['aadhaarNumber', 'AADHAAR'],
    ['fname', 'PERSON_NAME'],
    ['user_name', 'USERNAME'],
  ])('%s → %s via identifier words', (id, entity) => {
    expect(fieldEntitiesFromText(identifierToWords(id))[0]).toBe(entity);
  });
});
