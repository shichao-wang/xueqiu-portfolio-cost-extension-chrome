export interface MyExtensionOptions {
    option1: string;
    option2: boolean;
    option3?: number;
}

export interface UserData {
    id: string;
    name: string;
    email: string;
}

export type Message = {
    type: string;
    payload: any;
};