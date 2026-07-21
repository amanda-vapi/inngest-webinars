export type Customer = {
  id: string;
  name: string;
  email: string;
  phone: string;
  product: string;
  deviceModel: string;
  firmwareVersion: string;
  warrantyStatus: string;
};

export type Ticket = {
  id: string;
  reference: string;
  customerId: string;
  issue: string;
  status: string;
  createdAt: string;
  deviceModel: string | null;
  firmwareVersion: string | null;
  symptom: string | null;
  errorCode: string | null;
};

export type CreateTicketInput = {
  customerId: string;
  issue: string;
  deviceModel?: string;
  firmwareVersion?: string;
  symptom?: string;
  errorCode?: string;
};
