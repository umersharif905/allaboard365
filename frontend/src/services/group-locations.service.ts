// File: frontend/src/services/group-locations.service.ts
// Group Locations Service - Generic endpoints (multi-role support via backend)

import { apiService } from './api.service';

export interface GroupLocation {
  LocationId: string;
  GroupId: string;
  Name?: string;
  Address: string;
  Address2?: string;
  City: string;
  State: string;
  Zip: string;
  ContactName?: string;
  ContactPhone?: string;
  ContactEmail?: string;
  UseLocationACH: boolean;
  IsPrimary: boolean;
  Status: 'Active' | 'Inactive' | 'Archived';
  CreatedDate: string;
  ModifiedDate?: string;
  CreatedBy?: string;
  ModifiedBy?: string;
}

export interface PaymentMethod {
  PaymentMethodId: string;
  GroupId: string;
  LocationId?: string;
  Type: 'ACH' | 'CreditCard';
  Last4: string;
  BankName?: string;
  CardBrand?: string;
  ExpiryMonth?: number;
  ExpiryYear?: number;
  IsDefault: boolean;
  Status: 'Active' | 'Inactive';
  CreatedDate: string;
  BillingAddress?: string;
  BillingCity?: string;
  BillingState?: string;
  BillingZip?: string;
}

export class GroupLocationsService {
  /**
   * Get all locations for a group
   */
  static async getLocations(groupId: string) {
    return await apiService.get<{ success: boolean; data: GroupLocation[] }>(
      `/api/groups/${groupId}/locations`
    );
  }

  /**
   * Get a single location by ID
   */
  static async getLocation(groupId: string, locationId: string) {
    return await apiService.get<{ success: boolean; data: GroupLocation }>(
      `/api/groups/${groupId}/locations/${locationId}`
    );
  }

  /**
   * Create a new location for a group
   */
  static async createLocation(groupId: string, locationData: Partial<GroupLocation>) {
    return await apiService.post<{ success: boolean; data: GroupLocation; message?: string }>(
      `/api/groups/${groupId}/locations`,
      locationData
    );
  }

  /**
   * Update an existing location
   */
  static async updateLocation(
    groupId: string,
    locationId: string,
    locationData: Partial<GroupLocation>
  ) {
    return await apiService.put<{ success: boolean; data: GroupLocation; message?: string }>(
      `/api/groups/${groupId}/locations/${locationId}`,
      locationData
    );
  }

  /**
   * Delete a location
   */
  static async deleteLocation(groupId: string, locationId: string) {
    return await apiService.delete<{ success: boolean; message?: string }>(
      `/api/groups/${groupId}/locations/${locationId}`
    );
  }

  /**
   * Set a location as the primary location for the group
   */
  static async setPrimaryLocation(groupId: string, locationId: string) {
    return await apiService.put<{ success: boolean; message?: string }>(
      `/api/groups/${groupId}/locations/${locationId}/set-primary`
    );
  }

  /**
   * Get payment methods for a specific location
   */
  static async getLocationPaymentMethods(groupId: string, locationId: string) {
    return await apiService.get<{ success: boolean; data: PaymentMethod[] }>(
      `/api/groups/${groupId}/locations/${locationId}/payment-methods`
    );
  }

  /**
   * Add a payment method to a location
   */
  static async addLocationPaymentMethod(
    groupId: string,
    locationId: string,
    paymentMethodData: any
  ) {
    return await apiService.post<{ success: boolean; message?: string; data?: any }>(
      `/api/groups/${groupId}/locations/${locationId}/payment-method`,
      paymentMethodData
    );
  }

  /**
   * Delete a payment method from a location
   */
  static async deleteLocationPaymentMethod(
    groupId: string,
    locationId: string,
    paymentMethodId: string
  ) {
    return await apiService.delete<{ success: boolean; message?: string }>(
      `/api/groups/${groupId}/locations/${locationId}/payment-methods/${paymentMethodId}`
    );
  }

  /**
   * Set default payment method for a location
   */
  static async setDefaultPaymentMethod(
    groupId: string,
    locationId: string,
    paymentMethodId: string
  ) {
    return await apiService.put<{ success: boolean; message?: string }>(
      `/api/groups/${groupId}/locations/${locationId}/payment-methods/${paymentMethodId}/set-default`
    );
  }
}

export default GroupLocationsService;

